import hashlib
import uuid
from datetime import datetime, timezone
from typing import Callable

import redis.asyncio as redis
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models import ApiKey, User
from app.services.auth import verify_token

security = HTTPBearer()

_redis_pool: redis.Redis | None = None


async def get_redis() -> redis.Redis:
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = redis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis_pool


async def _try_api_key_auth(
    token: str, db: AsyncSession,
) -> User | None:
    """Try to authenticate via API key. Returns User with _api_key attached, or None."""
    # API keys don't contain dots; JWTs always have 2 dots
    if "." in token:
        return None

    key_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await db.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.is_active.is_(True))
    )
    api_key = result.scalar_one_or_none()
    if api_key is None:
        return None

    # Check expiry
    if api_key.expires_at and api_key.expires_at < datetime.now(timezone.utc):
        return None

    # Load owner
    user_result = await db.execute(
        select(User).where(User.id == api_key.owner_id, User.is_active.is_(True))
    )
    user = user_result.scalar_one_or_none()
    if user is None:
        return None

    # Update last_used_at (throttled: at most once per minute)
    now = datetime.now(timezone.utc)
    if api_key.last_used_at is None or (now - api_key.last_used_at).total_seconds() > 60:
        api_key.last_used_at = now
        await db.flush()

    # Attach API key to user as transient attribute
    user._api_key = api_key  # type: ignore[attr-defined]
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
    r: redis.Redis = Depends(get_redis),
) -> User:
    token = credentials.credentials

    # Try API key first (no dots = not JWT)
    if "." not in token:
        user = await _try_api_key_auth(token, db)
        if user is not None:
            return user
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    # JWT flow
    payload = verify_token(token, expected_type="access")
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    jti = payload.get("jti")
    if jti and await r.exists(f"blacklist:{jti}"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has been revoked",
        )

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = await db.execute(
        select(User).where(User.id == user_id, User.is_active.is_(True))
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )
    return user


def get_api_key(user: User) -> ApiKey | None:
    """Extract the API key from a user authenticated via API key."""
    return getattr(user, "_api_key", None)


def require_permission(permission: str) -> Callable:
    """Dependency factory that checks if the current user has a specific permission."""

    async def _check_permission(
        current_user: User = Depends(get_current_user),
    ) -> User:
        user_permissions: set[str] = set()
        for user_role in current_user.roles:
            role = user_role.role
            if role.permissions:
                user_permissions.update(
                    p.strip() for p in role.permissions.split(",") if p.strip()
                )

        if permission not in user_permissions:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permission '{permission}' required",
            )
        return current_user

    return _check_permission


def require_api_key_permission(permission: str) -> Callable:
    """Check that an API key has a specific permission scope."""

    def checker(user: User) -> None:
        api_key = get_api_key(user)
        if api_key is None:
            return  # JWT user, no API key restrictions
        perms = {p.strip() for p in api_key.permissions.split(",") if p.strip()}
        if permission not in perms:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API key lacks '{permission}' permission",
            )

    return checker
