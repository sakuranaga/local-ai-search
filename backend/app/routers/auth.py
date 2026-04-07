from datetime import datetime, timezone

import redis.asyncio as redis
from fastapi import APIRouter, Depends, HTTPException, Request, status
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

    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))

    await audit_log(db, user=user, action="login", request=request)

    from app.services.mail import notify_login
    from app.services.webhook import webhook_login
    _uname = user.display_name or user.username
    _ip = request.client.host if request.client else None
    notify_login(_uname, _ip)
    webhook_login(_uname, _ip)

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


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    current_user: User = Depends(get_current_user),
    r: redis.Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """Blacklist the current access token in Redis with a TTL matching token expiry."""
    await audit_log(db, user=current_user, action="logout", request=request)
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
