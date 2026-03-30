"""Admin endpoints for webhook endpoint management."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import User, WebhookEndpoint
from app.services.audit import audit_log

router = APIRouter(prefix="/admin/webhooks", tags=["webhooks"])


# ── Schemas ──────────────────────────────────────────────────────────

class WebhookOut(BaseModel):
    id: str
    name: str
    url: str
    format: str
    secret: str | None
    on_login: bool
    on_create: bool
    on_update: bool
    on_delete: bool
    enabled: bool

    class Config:
        from_attributes = True


class WebhookCreate(BaseModel):
    name: str
    url: str
    format: str = "json"
    secret: str | None = None


class WebhookUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    format: str | None = None
    secret: str | None = None
    on_login: bool | None = None
    on_create: bool | None = None
    on_update: bool | None = None
    on_delete: bool | None = None
    enabled: bool | None = None


class TestWebhookRequest(BaseModel):
    url: str
    format: str = "json"
    secret: str | None = None


def _to_out(ep: WebhookEndpoint) -> WebhookOut:
    return WebhookOut(
        id=str(ep.id), name=ep.name, url=ep.url, format=ep.format,
        secret=ep.secret, on_login=ep.on_login, on_create=ep.on_create,
        on_update=ep.on_update, on_delete=ep.on_delete, enabled=ep.enabled,
    )


# ── CRUD ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[WebhookOut])
async def list_webhooks(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(WebhookEndpoint).order_by(WebhookEndpoint.name)
    )
    return [_to_out(ep) for ep in result.scalars().all()]


@router.post("", response_model=WebhookOut, status_code=201)
async def create_webhook(
    body: WebhookCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    ep = WebhookEndpoint(name=body.name, url=body.url, format=body.format, secret=body.secret)
    db.add(ep)
    await db.flush()
    await audit_log(db, user=current_user, action="webhook.create", target_type="webhook",
                    target_id=str(ep.id), target_name=body.name,
                    detail={"url": body.url, "format": body.format}, request=request)
    await db.commit()
    await db.refresh(ep)
    return _to_out(ep)


@router.patch("/{webhook_id}", response_model=WebhookOut)
async def update_webhook(
    webhook_id: uuid.UUID,
    body: WebhookUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(WebhookEndpoint).where(WebhookEndpoint.id == webhook_id)
    )
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Webhook が見つかりません")
    changed = body.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(ep, field, value)
    await audit_log(db, user=current_user, action="webhook.update", target_type="webhook",
                    target_id=str(webhook_id), target_name=ep.name,
                    detail=changed, request=request)
    await db.commit()
    await db.refresh(ep)
    return _to_out(ep)


@router.delete("/{webhook_id}", status_code=204)
async def delete_webhook(
    webhook_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(WebhookEndpoint).where(WebhookEndpoint.id == webhook_id)
    )
    ep = result.scalar_one_or_none()
    if not ep:
        raise HTTPException(status_code=404, detail="Webhook が見つかりません")
    ep_name = ep.name
    await db.delete(ep)
    await audit_log(db, user=current_user, action="webhook.delete", target_type="webhook",
                    target_id=str(webhook_id), target_name=ep_name, request=request)
    await db.commit()


# ── Test ─────────────────────────────────────────────────────────────

@router.post("/test")
async def test_webhook(
    body: TestWebhookRequest,
    current_user: User = Depends(require_permission("admin")),
):
    from app.services.webhook import send_test_webhook
    result = await send_test_webhook(body.url, body.secret, body.format)
    if result == "ok":
        return {"status": "ok", "message": "テスト送信成功"}
    raise HTTPException(status_code=400, detail=result)
