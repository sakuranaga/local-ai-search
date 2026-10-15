import logging
import math
import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import redis.asyncio as redis
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.deps import get_current_user, get_redis
from app.models import User
from app.services.audit import audit_log
from app.services.auth import (
    authenticate_user,
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
    verify_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class AccessTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    display_name: str
    avatar_url: str | None
    is_active: bool
    locale: str | None = None
    roles: list[str]
    created_at: datetime

    model_config = {"from_attributes": True}


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, body.username, body.password)
    if user is None:
        await audit_log(db, action="login.failed", detail={"username": body.username}, request=request)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    user.last_login_at = datetime.now(timezone.utc)

    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))

    await audit_log(db, user=user, action="login", request=request)

    from app.services.mail import notify_login
    from app.services.webhook import webhook_login
    _uname = user.display_name or user.username
    _ip = request.client.host if request.client else None
    notify_login(_uname, _ip)
    webhook_login(_uname, _ip)

    # Sync password to Samba (file-based, picked up by samba entrypoint loop)
    _sync_smb_password(user.username, body.password)

    return TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/refresh", response_model=AccessTokenResponse)
async def refresh(
    body: RefreshRequest,
    r: redis.Redis = Depends(get_redis),
):
    payload = verify_token(body.refresh_token, expected_type="refresh")
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    jti = payload.get("jti")
    if jti and await r.exists(f"blacklist:{jti}"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has been revoked",
        )

    subject = payload["sub"]
    access_token = create_access_token(subject)

    return AccessTokenResponse(access_token=access_token)


class LogoutRequest(BaseModel):
    refresh_token: str | None = None


_optional_bearer = HTTPBearer(auto_error=False)


def _now() -> float:
    return time.time()


async def _revoke(r: redis.Redis, payloads: list[dict]) -> None:
    """Blacklist each token until a minute after it expires (rounded up: never gone before the token)."""
    for p in payloads:
        ttl = max(0, math.ceil(float(p["exp"]) - _now())) + 60  # design doc AO 2.2
        await r.set(f"blacklist:{p['jti']}", "1", ex=ttl)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    body: LogoutRequest | None = None,
    credentials: HTTPAuthorizationCredentials | None = Depends(_optional_bearer),
    r: redis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Revoke the tokens this browser holds: the access token (header) and the refresh token (body).

    No login required: an expired access token must not keep the refresh token alive, and revoking a
    token one holds harms no one. API keys are not touched. Nothing valid to revoke is still 204.
    """
    payloads = []
    if credentials and "." in credentials.credentials:
        p = verify_token(credentials.credentials, expected_type="access")
        if p and p.get("jti"):
            payloads.append(p)
    if body and body.refresh_token:
        p = verify_token(body.refresh_token, expected_type="refresh")
        if p and p.get("jti"):
            payloads.append(p)
    if not payloads:
        return None

    try:
        await _revoke(r, payloads)
    except Exception:  # Redis unreachable: the browser signs out anyway
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not revoke the tokens")

    user = None
    try:
        user = await db.get(User, uuid.UUID(payloads[0]["sub"]))
    except (KeyError, ValueError, TypeError):
        pass
    await audit_log(db, user=user, action="logout", request=request)
    return None


@router.get("/me", response_model=UserResponse)
async def me(current_user: User = Depends(get_current_user)):
    role_names = [ur.role.name for ur in current_user.roles]
    return UserResponse(
        id=str(current_user.id),
        username=current_user.username,
        email=current_user.email,
        display_name=current_user.display_name or "",
        avatar_url=current_user.avatar_url,
        is_active=current_user.is_active,
        locale=current_user.locale,
        roles=role_names,
        created_at=current_user.created_at,
    )


# ---------------------------------------------------------------------------
# User self-service profile update
# ---------------------------------------------------------------------------


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None
    email: str | None = None
    locale: str | None = None


@router.put("/me", response_model=UserResponse)
async def update_profile(
    body: ProfileUpdateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update own profile (display_name, avatar_url, email)."""
    changes: list[str] = []
    if body.display_name is not None:
        if len(body.display_name) > 8:
            raise HTTPException(status_code=400, detail="表示名は8文字以内で入力してください")
        current_user.display_name = body.display_name
        changes.append("display_name")
    if body.avatar_url is not None:
        current_user.avatar_url = body.avatar_url if body.avatar_url else None
        changes.append("avatar_url")
    if body.locale is not None:
        current_user.locale = body.locale if body.locale else None
        changes.append("locale")
    if body.email is not None:
        email = body.email.strip()
        if not email:
            raise HTTPException(status_code=400, detail="メールアドレスを入力してください")
        if email != current_user.email:
            from sqlalchemy import select as sa_select
            existing = await db.execute(
                sa_select(User).where(User.email == email, User.id != current_user.id)
            )
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=409, detail="このメールアドレスは既に使用されています")
            current_user.email = email
            changes.append("email")

    if changes:
        await audit_log(
            db, user=current_user, action="profile.update",
            target_type="user", target_id=str(current_user.id),
            detail={"changed_fields": changes}, request=request,
        )

    await db.commit()
    await db.refresh(current_user)
    role_names = [ur.role.name for ur in current_user.roles]
    return UserResponse(
        id=str(current_user.id),
        username=current_user.username,
        email=current_user.email,
        display_name=current_user.display_name or "",
        avatar_url=current_user.avatar_url,
        is_active=current_user.is_active,
        locale=current_user.locale,
        roles=role_names,
        created_at=current_user.created_at,
    )


# ---------------------------------------------------------------------------
# Change own password
# ---------------------------------------------------------------------------


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Change own password. Requires current password for verification."""
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="現在のパスワードが正しくありません")
    if len(body.new_password) < 4:
        raise HTTPException(status_code=400, detail="パスワードは4文字以上で入力してください")
    current_user.hashed_password = hash_password(body.new_password)
    await audit_log(
        db, user=current_user, action="password.change",
        target_type="user", target_id=str(current_user.id), request=request,
    )
    await db.commit()
    # Samba too, or SMB keeps taking the old password until the next login
    _sync_smb_password(current_user.username, body.new_password)


# ---------------------------------------------------------------------------
# Avatar upload / delete / serve
# ---------------------------------------------------------------------------

AVATAR_DIR = Path(os.environ.get("STORAGE_PATH", "/app/storage")) / "avatars"
AVATAR_MAX_SIZE = 2 * 1024 * 1024  # 2 MB
AVATAR_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
AVATAR_EXT_MAP = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}


@router.post("/avatar", response_model=UserResponse)
async def upload_avatar(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload avatar image. Filename is user ID; overwrites previous."""
    if file.content_type not in AVATAR_ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="JPEG, PNG, GIF, WebPのみ対応しています")

    data = await file.read()
    if len(data) > AVATAR_MAX_SIZE:
        raise HTTPException(status_code=400, detail="ファイルサイズは2MB以下にしてください")

    AVATAR_DIR.mkdir(parents=True, exist_ok=True)

    # Remove old avatar (any extension)
    for old in AVATAR_DIR.glob(f"{current_user.id}.*"):
        old.unlink(missing_ok=True)

    ext = AVATAR_EXT_MAP.get(file.content_type, ".png")
    filename = f"{current_user.id}{ext}"
    dest = AVATAR_DIR / filename
    dest.write_bytes(data)

    import time
    current_user.avatar_url = f"/api/auth/avatars/{filename}?v={int(time.time())}"
    await db.commit()
    await db.refresh(current_user)
    role_names = [ur.role.name for ur in current_user.roles]
    return UserResponse(
        id=str(current_user.id),
        username=current_user.username,
        email=current_user.email,
        display_name=current_user.display_name or "",
        avatar_url=current_user.avatar_url,
        is_active=current_user.is_active,
        locale=current_user.locale,
        roles=role_names,
        created_at=current_user.created_at,
    )


@router.delete("/avatar", response_model=UserResponse)
async def delete_avatar(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete avatar image."""
    for old in AVATAR_DIR.glob(f"{current_user.id}.*"):
        old.unlink(missing_ok=True)

    current_user.avatar_url = None
    await db.commit()
    await db.refresh(current_user)
    role_names = [ur.role.name for ur in current_user.roles]
    return UserResponse(
        id=str(current_user.id),
        username=current_user.username,
        email=current_user.email,
        display_name=current_user.display_name or "",
        avatar_url=current_user.avatar_url,
        is_active=current_user.is_active,
        locale=current_user.locale,
        roles=role_names,
        created_at=current_user.created_at,
    )


@router.get("/avatars/{filename}")
async def serve_avatar(filename: str):
    """Serve avatar image file."""
    # Sanitize filename to prevent path traversal
    safe = Path(filename).name
    path = AVATAR_DIR / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="Avatar not found")
    return FileResponse(path)


# ---------------------------------------------------------------------------
# SMB Authentication (internal API, not exposed via nginx)
# ---------------------------------------------------------------------------

_SMB_SYNC_DIR = "/smb-sync"


# User names samba's adduser takes; others are left out of the SMB user list
_SMB_NAME = re.compile(r"[a-z_][a-z0-9_.-]*")
_log = logging.getLogger(__name__)


def _sync_smb_password(username: str, password: str):
    """Write password file for Samba sync loop to pick up.

    Written to a temporary file of its own in the same folder and renamed over, so samba never reads a part-written
    file and two logins of one user do not share a temporary file."""
    tmp = None
    try:
        os.makedirs(_SMB_SYNC_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=_SMB_SYNC_DIR, prefix=f".{username}.", suffix=".tmp")  # 0600
        with os.fdopen(fd, "w") as f:
            f.write(f"{username}\n{password}")
        os.replace(tmp, os.path.join(_SMB_SYNC_DIR, f"{username}.passwd"))
    except OSError:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        # SMB sync dir not mounted — skip silently


_SMB_INTERNAL_KEY = os.environ.get("SMB_INTERNAL_KEY", "")


def _verify_internal_key(request: Request):
    if not _SMB_INTERNAL_KEY:
        raise HTTPException(503, "SMB_INTERNAL_KEY not configured")
    key = request.headers.get("X-Internal-Key", "")
    if key != _SMB_INTERNAL_KEY:
        raise HTTPException(401, "Invalid internal key")


async def _ensure_unix_id(db: AsyncSession, row, column, seq) -> int:
    """Give `row` the next number of `seq` unless it has one. Numbers are never given twice, also after a user or a
    group is deleted; a request that gave it one meanwhile wins, waited for by the row lock."""
    from sqlalchemy import select, update
    from sqlalchemy.orm.attributes import set_committed_value

    model = type(row)
    if getattr(row, column.key) is not None:
        return getattr(row, column.key)
    number = (await db.execute(
        update(model).where(model.id == row.id, column.is_(None))
        .values({column.key: seq.next_value()}).returning(column)
        .execution_options(synchronize_session=False)
    )).scalar_one_or_none()
    if number is None:  # given one meanwhile
        number = (await db.execute(select(column).where(model.id == row.id))).scalar_one()
    set_committed_value(row, column.key, number)
    return number


async def _ensure_unix_uid(db: AsyncSession, user: User) -> int:
    """Assign a unix_uid if not yet set. Returns the uid."""
    from app.models import UNIX_UID_SEQ
    return await _ensure_unix_id(db, user, User.unix_uid, UNIX_UID_SEQ)


async def _ensure_unix_gid(db: AsyncSession, group) -> int:
    """Assign a unix_gid if not yet set. Returns the gid."""
    from app.models import UNIX_GID_SEQ, Group
    return await _ensure_unix_id(db, group, Group.unix_gid, UNIX_GID_SEQ)


@router.post("/smb-verify")
async def smb_verify(request: Request, db: AsyncSession = Depends(get_db)):
    """Verify credentials for SMB PAM authentication."""
    _verify_internal_key(request)
    form = await request.form()
    username = form.get("username", "")
    password = form.get("password", "")
    if not username or not password:
        raise HTTPException(401, "Missing credentials")

    user = await authenticate_user(db, str(username), str(password))
    if user is None:
        raise HTTPException(401, "Invalid credentials")

    uid = await _ensure_unix_uid(db, user)

    # Gather group info
    from sqlalchemy import select
    from app.models import Group, GroupMember
    from app.services.permissions import is_admin

    gm_result = await db.execute(
        select(Group).join(GroupMember).where(GroupMember.user_id == user.id)
    )
    groups = gm_result.scalars().all()
    group_info = []
    primary_gid = 65534  # nogroup
    for g in groups:
        gid = await _ensure_unix_gid(db, g)
        group_info.append({"name": g.name, "gid": gid})
        if primary_gid == 65534:
            primary_gid = gid

    await db.commit()
    return {
        "uid": uid,
        "gid": primary_gid,
        "groups": ",".join(g["name"] for g in group_info),
        "is_admin": is_admin(user),
    }


@router.get("/smb-users")
async def smb_users(request: Request, db: AsyncSession = Depends(get_db)):
    """Return all active users and groups for Samba entrypoint sync."""
    _verify_internal_key(request)

    from sqlalchemy import select
    from app.models import Group, GroupMember

    # Ensure all users have unix_uid
    user_result = await db.execute(select(User).where(User.is_active.is_(True)))
    users = user_result.scalars().all()
    for u in users:
        await _ensure_unix_uid(db, u)

    # Ensure all groups have unix_gid
    group_result = await db.execute(select(Group))
    groups = group_result.scalars().all()
    for g in groups:
        await _ensure_unix_gid(db, g)

    # Each user's groups by gid: names may hold spaces, commas or Japanese
    gm_result = await db.execute(select(GroupMember))
    gid_of = {g.id: g.unix_gid for g in groups}
    user_gids: dict[str, list[int]] = {}
    for gm in gm_result.scalars().all():
        if gm.group_id in gid_of:
            user_gids.setdefault(str(gm.user_id), []).append(gid_of[gm.group_id])

    await db.commit()
    listed = []
    for u in users:
        if not _SMB_NAME.fullmatch(u.username):  # not match: "$" also takes a trailing newline
            _log.warning("SMB: user %r left out: the name is not one samba takes", u.username)
            continue
        listed.append({"uid": u.unix_uid, "username": u.username, "gids": sorted(user_gids.get(str(u.id), []))})
    return {"users": listed, "groups": [{"gid": g.unix_gid} for g in groups]}
