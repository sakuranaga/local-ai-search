"""Share link endpoints — create and manage share links.

Files are transferred to the external LAS Share Server.
No public endpoints here — external users access the Share Server directly.
"""

import hashlib
import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import Document, File, ShareLink, User
from app.services.permissions import is_admin as _is_admin, can_access_document
from app.services.settings import get_setting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/share", tags=["share"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ShareLinkCreate(BaseModel):
    document_id: str
    password: str | None = None
    expires_in: str = "7d"  # "1h" | "1d" | "7d" | "30d"


class ShareLinkResponse(BaseModel):
    id: str
    document_id: str
    document_title: str
    token: str
    url: str
    has_password: bool
    expires_at: datetime
    created_by_name: str
    created_at: datetime
    is_active: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_expires_in(expires_in: str) -> datetime:
    now = datetime.now(timezone.utc)
    mapping = {
        "1h": timedelta(hours=1),
        "1d": timedelta(days=1),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    delta = mapping.get(expires_in, timedelta(days=7))
    return now + delta


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


async def _upload_to_share_server(
    doc: Document,
    file_record: File,
    token: str,
    password_hash: str,
    expires_at: datetime,
    username: str,
    db: AsyncSession,
) -> str:
    """Upload file and metadata to the external Share Server. Returns the share URL."""
    share_url = await get_setting(db, "share_server_url")
    api_key = await get_setting(db, "share_server_api_key")

    if not share_url or not api_key:
        raise HTTPException(
            status_code=503,
            detail="Share Server が設定されていません。管理画面で share_server_url と share_server_api_key を設定してください。",
        )

    file_path = Path(file_record.storage_path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
        with open(file_path, "rb") as f:
            response = await client.post(
                f"{share_url.rstrip('/')}/api/internal/upload",
                headers={"X-Api-Key": api_key},
                files={"file": (file_record.filename, f)},
                data={
                    "token": token,
                    "filename": doc.title,
                    "file_type": doc.file_type,
                    "password_hash": password_hash or "",
                    "expires_at": expires_at.isoformat(),
                    "created_by": username,
                },
            )

    if response.status_code != 201:
        logger.error("Share Server upload failed: %s %s", response.status_code, response.text)
        raise HTTPException(status_code=502, detail="Share Server へのアップロードに失敗しました")

    return response.json()["url"]


async def _delete_from_share_server(token: str, db: AsyncSession):
    """Delete a share link from the external Share Server."""
    share_url = await get_setting(db, "share_server_url")
    api_key = await get_setting(db, "share_server_api_key")
    if not share_url or not api_key:
        return

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            await client.delete(
                f"{share_url.rstrip('/')}/api/internal/{token}",
                headers={"X-Api-Key": api_key},
            )
    except Exception as e:
        logger.warning("Failed to delete from Share Server: %s", e)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/test-connection")
async def test_share_server_connection(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Test connection to the external Share Server."""
    share_url = await get_setting(db, "share_server_url")
    api_key = await get_setting(db, "share_server_api_key")

    if not share_url or not api_key:
        return {"ok": False, "error": "share_server_url と share_server_api_key を設定してください"}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            response = await client.get(
                f"{share_url.rstrip('/')}/api/internal/status",
                headers={"X-Api-Key": api_key},
            )
        if response.status_code == 200:
            data = response.json()
            return {"ok": True, "active_links": data.get("active_links", 0), "api_keys": data.get("api_keys", 0)}
        elif response.status_code == 401:
            return {"ok": False, "error": "APIキーが無効です"}
        else:
            return {"ok": False, "error": f"Share Server エラー: {response.status_code}"}
    except httpx.ConnectError:
        return {"ok": False, "error": "Share Server に接続できません"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("", response_model=ShareLinkResponse, status_code=status.HTTP_201_CREATED)
async def create_share_link(
    body: ShareLinkCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Check sharing is enabled
    enabled = await get_setting(db, "share_enabled")
    if enabled and enabled.lower() == "false":
        raise HTTPException(status_code=403, detail="共有機能が無効です")

    doc_id = uuid.UUID(body.document_id)
    result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not await can_access_document(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Check share restrictions
    if doc.share_prohibited:
        raise HTTPException(status_code=403, detail="このファイルは共有が禁止されています")
    if not _is_admin(current_user) and not current_user.can_share:
        raise HTTPException(status_code=403, detail="共有権限がありません")

    # Get file record
    file_result = await db.execute(select(File).where(File.document_id == doc.id))
    file_record = file_result.scalars().first()
    if file_record is None:
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    token = secrets.token_urlsafe(32)
    password_hash = _hash_password(body.password) if body.password else ""
    expires_at = _parse_expires_in(body.expires_in)

    # Upload to Share Server
    share_url = await _upload_to_share_server(
        doc, file_record, token, password_hash, expires_at, current_user.username, db,
    )

    # Save local record
    link = ShareLink(
        document_id=doc_id,
        token=token,
        has_password=bool(body.password),
        expires_at=expires_at,
        share_url=share_url,
        created_by_id=current_user.id,
    )
    db.add(link)
    await db.flush()
    await db.refresh(link)

    return ShareLinkResponse(
        id=str(link.id),
        document_id=str(doc.id),
        document_title=doc.title,
        token=token,
        url=share_url,
        has_password=link.has_password,
        expires_at=link.expires_at,
        created_by_name=current_user.username,
        created_at=link.created_at,
        is_active=True,
    )


@router.get("/list", response_model=list[ShareLinkResponse])
async def list_share_links(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = (
        select(ShareLink, Document.title, User.username)
        .join(Document, ShareLink.document_id == Document.id)
        .join(User, ShareLink.created_by_id == User.id)
        .order_by(ShareLink.created_at.desc())
    )
    if not _is_admin(current_user):
        stmt = stmt.where(ShareLink.created_by_id == current_user.id)

    result = await db.execute(stmt)
    return [
        ShareLinkResponse(
            id=str(link.id),
            document_id=str(link.document_id),
            document_title=doc_title,
            token=link.token,
            url=link.share_url,
            has_password=link.has_password,
            expires_at=link.expires_at,
            created_by_name=username,
            created_at=link.created_at,
            is_active=link.is_active,
        )
        for link, doc_title, username in result.all()
    ]


@router.delete("/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_share_link(
    link_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = await db.get(ShareLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Share link not found")
    if link.created_by_id != current_user.id and not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    # Delete from Share Server
    await _delete_from_share_server(link.token, db)

    link.is_active = False
