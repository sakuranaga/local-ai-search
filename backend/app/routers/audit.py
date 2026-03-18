"""Audit log endpoints (admin only)."""

from __future__ import annotations

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import AuditLog, User

router = APIRouter(prefix="/admin/audit-logs", tags=["audit"])


class AuditLogItem(BaseModel):
    id: int
    user_id: str | None
    username: str
    action: str
    target_type: str | None
    target_id: str | None
    target_name: str | None
    detail: str | None
    ip_address: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class AuditLogListResponse(BaseModel):
    items: list[AuditLogItem]
    total: int
    page: int
    per_page: int


@router.get("", response_model=AuditLogListResponse)
async def list_audit_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    action: str | None = None,
    user_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    q: str | None = None,
    _admin: User = Depends(require_permission("admin")),
    db: AsyncSession = Depends(get_db),
):
    query = select(AuditLog)
    count_query = select(func.count()).select_from(AuditLog)

    if action:
        query = query.where(AuditLog.action == action)
        count_query = count_query.where(AuditLog.action == action)
    if user_id:
        query = query.where(AuditLog.user_id == user_id)
        count_query = count_query.where(AuditLog.user_id == user_id)
    if date_from:
        query = query.where(AuditLog.created_at >= date_from)
        count_query = count_query.where(AuditLog.created_at >= date_from)
    if date_to:
        query = query.where(AuditLog.created_at <= date_to + "T23:59:59+09:00")
        count_query = count_query.where(AuditLog.created_at <= date_to + "T23:59:59+09:00")
    if q:
        pattern = f"%{q}%"
        query = query.where(
            AuditLog.target_name.ilike(pattern) | AuditLog.detail.ilike(pattern) | AuditLog.username.ilike(pattern)
        )
        count_query = count_query.where(
            AuditLog.target_name.ilike(pattern) | AuditLog.detail.ilike(pattern) | AuditLog.username.ilike(pattern)
        )

    total = await db.scalar(count_query) or 0

    query = query.order_by(desc(AuditLog.created_at)).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    items = result.scalars().all()

    return AuditLogListResponse(
        items=[
            AuditLogItem(
                id=item.id,
                user_id=str(item.user_id) if item.user_id else None,
                username=item.username,
                action=item.action,
                target_type=item.target_type,
                target_id=item.target_id,
                target_name=item.target_name,
                detail=item.detail,
                ip_address=item.ip_address,
                created_at=item.created_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/actions")
async def list_actions(
    _admin: User = Depends(require_permission("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Return distinct action values for the filter dropdown."""
    result = await db.execute(
        select(AuditLog.action).distinct().order_by(AuditLog.action)
    )
    return [r for r in result.scalars().all()]


@router.get("/export")
async def export_csv(
    action: str | None = None,
    user_id: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    q: str | None = None,
    _admin: User = Depends(require_permission("admin")),
    db: AsyncSession = Depends(get_db),
):
    """Export audit logs as CSV."""
    query = select(AuditLog)
    if action:
        query = query.where(AuditLog.action == action)
    if user_id:
        query = query.where(AuditLog.user_id == user_id)
    if date_from:
        query = query.where(AuditLog.created_at >= date_from)
    if date_to:
        query = query.where(AuditLog.created_at <= date_to + "T23:59:59+09:00")
    if q:
        pattern = f"%{q}%"
        query = query.where(
            AuditLog.target_name.ilike(pattern) | AuditLog.detail.ilike(pattern) | AuditLog.username.ilike(pattern)
        )

    query = query.order_by(desc(AuditLog.created_at)).limit(10000)
    result = await db.execute(query)
    items = result.scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["日時", "ユーザー", "アクション", "対象種別", "対象ID", "対象名", "詳細", "IPアドレス"])
    for item in items:
        writer.writerow([
            item.created_at.isoformat() if item.created_at else "",
            item.username,
            item.action,
            item.target_type or "",
            item.target_id or "",
            item.target_name or "",
            item.detail or "",
            item.ip_address or "",
        ])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_logs.csv"},
    )
