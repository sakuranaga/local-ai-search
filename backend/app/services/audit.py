"""Audit logging helper."""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog, User


def _normalize_ip(ip: str | None) -> str | None:
    """Strip IPv4-mapped IPv6 prefix (::ffff:) to show plain IPv4."""
    if ip and ip.startswith("::ffff:"):
        return ip[7:]
    return ip


async def audit_log(
    db: AsyncSession,
    *,
    user: User | None = None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    target_name: str | None = None,
    detail: dict[str, Any] | str | None = None,
    request: Request | None = None,
    ip_address: str | None = None,
) -> AuditLog:
    """Write a single audit log entry."""
    ip = ip_address
    if ip is None and request is not None:
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
            request.client.host if request.client else None
        )
    ip = _normalize_ip(ip)

    detail_str = None
    if detail is not None:
        detail_str = json.dumps(detail, ensure_ascii=False) if isinstance(detail, dict) else str(detail)

    entry = AuditLog(
        user_id=user.id if user else None,
        username=(user.display_name or user.username) if user else "",
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_name=target_name,
        detail=detail_str,
        ip_address=ip,
    )
    db.add(entry)
    await db.flush()
    return entry
