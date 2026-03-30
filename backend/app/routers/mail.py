"""Admin endpoints for mail notification configuration and recipients."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import MailRecipient, User
from app.services.audit import audit_log

router = APIRouter(prefix="/admin/mail", tags=["mail"])


# ── Schemas ──────────────────────────────────────────────────────────

class RecipientOut(BaseModel):
    id: str
    email: str
    on_login: bool
    on_create: bool
    on_update: bool
    on_delete: bool
    enabled: bool

    class Config:
        from_attributes = True


class RecipientCreate(BaseModel):
    email: str


class RecipientUpdate(BaseModel):
    on_login: bool | None = None
    on_create: bool | None = None
    on_update: bool | None = None
    on_delete: bool | None = None
    enabled: bool | None = None


class TestMailRequest(BaseModel):
    to: str


# ── Recipients CRUD ─────────────────────────────────────────────────

@router.get("/recipients", response_model=list[RecipientOut])
async def list_recipients(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(MailRecipient).order_by(MailRecipient.email)
    )
    return [
        RecipientOut(id=str(r.id), email=r.email, on_login=r.on_login,
                     on_create=r.on_create, on_update=r.on_update,
                     on_delete=r.on_delete, enabled=r.enabled)
        for r in result.scalars().all()
    ]


@router.post("/recipients", response_model=RecipientOut, status_code=201)
async def add_recipient(
    body: RecipientCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    existing = await db.execute(
        select(MailRecipient).where(MailRecipient.email == body.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="このメールアドレスは既に登録されています")
    r = MailRecipient(email=body.email)
    db.add(r)
    await db.flush()
    await audit_log(db, user=current_user, action="mail_recipient.create", target_type="mail_recipient",
                    target_id=str(r.id), target_name=body.email, request=request)
    await db.commit()
    await db.refresh(r)
    return RecipientOut(id=str(r.id), email=r.email, on_login=r.on_login,
                        on_create=r.on_create, on_update=r.on_update,
                        on_delete=r.on_delete, enabled=r.enabled)


@router.patch("/recipients/{recipient_id}", response_model=RecipientOut)
async def update_recipient(
    recipient_id: uuid.UUID,
    body: RecipientUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(MailRecipient).where(MailRecipient.id == recipient_id)
    )
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="通知先が見つかりません")
    changed = body.model_dump(exclude_unset=True)
    for field, value in changed.items():
        setattr(r, field, value)
    await audit_log(db, user=current_user, action="mail_recipient.update", target_type="mail_recipient",
                    target_id=str(recipient_id), target_name=r.email,
                    detail=changed, request=request)
    await db.commit()
    await db.refresh(r)
    return RecipientOut(id=str(r.id), email=r.email, on_login=r.on_login,
                        on_create=r.on_create, on_update=r.on_update,
                        on_delete=r.on_delete, enabled=r.enabled)


@router.delete("/recipients/{recipient_id}", status_code=204)
async def delete_recipient(
    recipient_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(MailRecipient).where(MailRecipient.id == recipient_id)
    )
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="通知先が見つかりません")
    email = r.email
    await db.delete(r)
    await audit_log(db, user=current_user, action="mail_recipient.delete", target_type="mail_recipient",
                    target_id=str(recipient_id), target_name=email, request=request)
    await db.commit()


# ── Test mail ────────────────────────────────────────────────────────

@router.post("/test")
async def test_mail(
    body: TestMailRequest,
    current_user: User = Depends(require_permission("admin")),
):
    from app.services.mail import send_test_email
    result = await send_test_email(body.to)
    if result == "ok":
        return {"status": "ok", "message": "テストメールを送信しました"}
    raise HTTPException(status_code=400, detail=result)
