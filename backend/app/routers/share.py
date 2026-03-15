"""Share link endpoints — create, manage, and serve shared documents.

Public endpoints (no auth): GET /share/{token}, POST /share/{token}/verify,
  GET /share/{token}/preview, GET /share/{token}/download
Authenticated endpoints: POST /share, GET /share/list, DELETE /share/{id}, PATCH /share/{id}
"""

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
import hashlib

from jose import jwt
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.deps import get_current_user
from app.models import Document, File, ShareLink, ShareLinkAccessLog, User
from app.services.permissions import is_admin as _is_admin, can_access_document
from app.services.settings import get_setting

router = APIRouter(prefix="/share", tags=["share"])

def _hash_password(password: str) -> str:
    """Hash a share link password with SHA-256 + salt."""
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _verify_password(password: str, hashed: str) -> bool:
    """Verify a share link password."""
    salt, h = hashed.split("$", 1)
    return hashlib.sha256((salt + password).encode()).hexdigest() == h


SHARE_TOKEN_SECRET = settings.JWT_SECRET
SHARE_TOKEN_ALGO = "HS256"
SHARE_TOKEN_EXPIRE_MINUTES = 30


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ShareLinkCreate(BaseModel):
    document_id: str
    password: str | None = None
    max_downloads: int | None = None
    expires_in: str | None = None  # "1h" | "1d" | "7d" | "30d" | None


class ShareLinkUpdate(BaseModel):
    password: str | None = None  # "" to remove password
    max_downloads: int | None = None
    expires_in: str | None = None
    is_active: bool | None = None


class ShareLinkResponse(BaseModel):
    id: str
    document_id: str
    document_title: str
    token: str
    url: str
    has_password: bool
    max_downloads: int | None
    download_count: int
    expires_at: datetime | None
    created_by_name: str
    created_at: datetime
    is_active: bool
    access_count: int = 0


class SharePublicResponse(BaseModel):
    document_title: str
    file_type: str
    requires_password: bool
    created_by_name: str
    expires_at: datetime | None


class SharePasswordVerify(BaseModel):
    password: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_expires_in(expires_in: str | None) -> datetime | None:
    if not expires_in:
        return None
    now = datetime.now(timezone.utc)
    mapping = {"1h": timedelta(hours=1), "1d": timedelta(days=1), "7d": timedelta(days=7), "30d": timedelta(days=30), "90d": timedelta(days=90)}
    delta = mapping.get(expires_in)
    if delta:
        return now + delta
    return None


async def _get_share_url(db: AsyncSession, token: str) -> str:
    base = await get_setting(db, "share_base_url")
    if base:
        base = base.rstrip("/")
        # Ensure /s/ path is included
        if not base.endswith("/s"):
            base += "/s"
        return f"{base}/{token}"
    return f"/s/{token}"


async def _validate_share_link(link: ShareLink) -> str | None:
    """Return error message if link is invalid, else None."""
    if not link.is_active:
        return "この共有リンクは無効です"
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        return "この共有リンクの有効期限が切れています"
    if link.max_downloads and link.download_count >= link.max_downloads:
        return "ダウンロード回数の上限に達しました"
    return None


def _create_share_token(link_id: str) -> str:
    """Create a temporary JWT for password-verified access."""
    exp = datetime.now(timezone.utc) + timedelta(minutes=SHARE_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": link_id, "exp": exp, "type": "share"}, SHARE_TOKEN_SECRET, algorithm=SHARE_TOKEN_ALGO)


def _verify_share_token(token: str) -> str | None:
    """Verify share JWT and return link_id or None."""
    try:
        payload = jwt.decode(token, SHARE_TOKEN_SECRET, algorithms=[SHARE_TOKEN_ALGO])
        if payload.get("type") != "share":
            return None
        return payload.get("sub")
    except Exception:
        return None


async def _check_password_access(link: ShareLink, request: Request) -> bool:
    """Check if password-protected link has valid access token."""
    if not link.password_hash:
        return True
    auth = request.headers.get("x-share-token", "") or request.query_params.get("share_token", "")
    if not auth:
        return False
    verified_id = _verify_share_token(auth)
    return verified_id == str(link.id)


def _log_access(db: AsyncSession, link_id: uuid.UUID, action: str, request: Request):
    db.add(ShareLinkAccessLog(
        share_link_id=link_id,
        action=action,
        ip_address=request.headers.get("x-real-ip", request.client.host if request.client else None),
        user_agent=request.headers.get("user-agent"),
    ))


# ---------------------------------------------------------------------------
# Authenticated endpoints (main app)
# ---------------------------------------------------------------------------


@router.post("", response_model=ShareLinkResponse, status_code=status.HTTP_201_CREATED)
async def create_share_link(
    body: ShareLinkCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc_id = uuid.UUID(body.document_id)
    result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not await can_access_document(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Check if sharing is enabled
    enabled = await get_setting(db, "share_enabled")
    if enabled and enabled.lower() == "false":
        raise HTTPException(status_code=403, detail="Sharing is disabled")

    token = secrets.token_urlsafe(32)
    password_hash = _hash_password(body.password) if body.password else None
    expires_at = _parse_expires_in(body.expires_in)

    link = ShareLink(
        document_id=doc_id,
        token=token,
        password_hash=password_hash,
        max_downloads=body.max_downloads,
        expires_at=expires_at,
        created_by_id=current_user.id,
    )
    db.add(link)
    await db.flush()
    await db.refresh(link)

    url = await _get_share_url(db, token)

    return ShareLinkResponse(
        id=str(link.id),
        document_id=str(doc.id),
        document_title=doc.title,
        token=token,
        url=url,

        has_password=link.password_hash is not None,
        max_downloads=link.max_downloads,
        download_count=0,
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
        select(ShareLink, Document.title, User.username,
               func.count(ShareLinkAccessLog.id).label("access_count"))
        .join(Document, ShareLink.document_id == Document.id)
        .join(User, ShareLink.created_by_id == User.id)
        .outerjoin(ShareLinkAccessLog, ShareLink.id == ShareLinkAccessLog.share_link_id)
        .group_by(ShareLink.id, Document.title, User.username)
        .order_by(ShareLink.created_at.desc())
    )
    if not _is_admin(current_user):
        stmt = stmt.where(ShareLink.created_by_id == current_user.id)

    result = await db.execute(stmt)
    items = []
    for link, doc_title, username, access_count in result.all():
        url = await _get_share_url(db, link.token)
        items.append(ShareLinkResponse(
            id=str(link.id),
            document_id=str(link.document_id),
            document_title=doc_title,
            token=link.token,
            url=url,
    
            has_password=link.password_hash is not None,
            max_downloads=link.max_downloads,
            download_count=link.download_count,
            expires_at=link.expires_at,
            created_by_name=username,
            created_at=link.created_at,
            is_active=link.is_active,
            access_count=access_count,
        ))
    return items


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
    link.is_active = False


@router.patch("/{link_id}", response_model=ShareLinkResponse)
async def update_share_link(
    link_id: uuid.UUID,
    body: ShareLinkUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    link = await db.get(ShareLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Share link not found")
    if link.created_by_id != current_user.id and not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    if body.password is not None:
        link.password_hash = _hash_password(body.password) if body.password else None
    if body.max_downloads is not None:
        link.max_downloads = body.max_downloads if body.max_downloads > 0 else None
    if body.expires_in is not None:
        link.expires_at = _parse_expires_in(body.expires_in)
    if body.is_active is not None:
        link.is_active = body.is_active

    await db.flush()
    await db.refresh(link)

    doc = await db.get(Document, link.document_id)
    r = await db.execute(select(User.username).where(User.id == link.created_by_id))
    username = r.scalar_one_or_none() or ""
    url = await _get_share_url(db, link.token)

    access_count = (await db.execute(
        select(func.count(ShareLinkAccessLog.id)).where(ShareLinkAccessLog.share_link_id == link.id)
    )).scalar() or 0

    return ShareLinkResponse(
        id=str(link.id),
        document_id=str(link.document_id),
        document_title=doc.title if doc else "",
        token=link.token,
        url=url,

        has_password=link.password_hash is not None,
        max_downloads=link.max_downloads,
        download_count=link.download_count,
        expires_at=link.expires_at,
        created_by_name=username,
        created_at=link.created_at,
        is_active=link.is_active,
        access_count=access_count,
    )


# ---------------------------------------------------------------------------
# Public endpoints (share page, no auth required)
# ---------------------------------------------------------------------------


@router.get("/public/{token}", response_model=SharePublicResponse)
async def get_share_public(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ShareLink).where(ShareLink.token == token))
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="共有リンクが見つかりません")

    error = await _validate_share_link(link)
    if error:
        raise HTTPException(status_code=410, detail=error)

    doc = await db.get(Document, link.document_id)
    if doc is None or doc.deleted_at is not None:
        raise HTTPException(status_code=404, detail="ドキュメントが見つかりません")

    r = await db.execute(select(User.username).where(User.id == link.created_by_id))
    username = r.scalar_one_or_none() or ""

    _log_access(db, link.id, "view", request)

    return SharePublicResponse(
        document_title=doc.title,
        file_type=doc.file_type,

        requires_password=link.password_hash is not None,
        created_by_name=username,
        expires_at=link.expires_at,
    )


@router.post("/public/{token}/verify")
async def verify_share_password(
    token: str,
    body: SharePasswordVerify,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ShareLink).where(ShareLink.token == token))
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="共有リンクが見つかりません")

    error = await _validate_share_link(link)
    if error:
        raise HTTPException(status_code=410, detail=error)

    if not link.password_hash:
        return {"share_token": _create_share_token(str(link.id))}

    if not _verify_password(body.password, link.password_hash):
        _log_access(db, link.id, "password_fail", request)
        raise HTTPException(status_code=401, detail="パスワードが正しくありません")

    return {"share_token": _create_share_token(str(link.id))}


@router.get("/public/{token}/preview")
async def preview_share(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ShareLink).where(ShareLink.token == token))
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="共有リンクが見つかりません")

    error = await _validate_share_link(link)
    if error:
        raise HTTPException(status_code=410, detail=error)

    if not await _check_password_access(link, request):
        raise HTTPException(status_code=401, detail="パスワード認証が必要です")

    doc = await db.get(Document, link.document_id)
    if doc is None or doc.deleted_at is not None:
        raise HTTPException(status_code=404, detail="ドキュメントが見つかりません")

    return {"title": doc.title, "file_type": doc.file_type, "content": doc.content}


@router.get("/public/{token}/download")
async def download_share(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(ShareLink).where(ShareLink.token == token))
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="共有リンクが見つかりません")

    error = await _validate_share_link(link)
    if error:
        raise HTTPException(status_code=410, detail=error)

    if not await _check_password_access(link, request):
        raise HTTPException(status_code=401, detail="パスワード認証が必要です")

    doc = await db.get(Document, link.document_id)
    if doc is None or doc.deleted_at is not None:
        raise HTTPException(status_code=404, detail="ドキュメントが見つかりません")

    file_result = await db.execute(select(File).where(File.document_id == doc.id))
    file_record = file_result.scalars().first()
    if file_record is None or not Path(file_record.storage_path).exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")

    # Increment download count
    link.download_count += 1
    _log_access(db, link.id, "download", request)

    return FileResponse(
        path=file_record.storage_path,
        filename=file_record.filename,
        media_type=file_record.mime_type or "application/octet-stream",
    )
