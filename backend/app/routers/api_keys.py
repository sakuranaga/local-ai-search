import hashlib
import secrets
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import ApiKey, Folder, User

router = APIRouter(prefix="/api-keys", tags=["api-keys"])

VALID_PERMISSIONS = {"upload", "delete", "search", "overwrite"}


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ApiKeyCreate(BaseModel):
    name: str
    owner_id: str
    folder_id: str | None = None
    permissions: list[str] = ["upload"]
    allow_overwrite: bool = False
    expires_at: datetime | None = None


class ApiKeyUpdate(BaseModel):
    name: str | None = None
    folder_id: str | None = None
    permissions: list[str] | None = None
    allow_overwrite: bool | None = None
    is_active: bool | None = None
    expires_at: datetime | None = None


class ApiKeyResponse(BaseModel):
    id: str
    name: str
    key_prefix: str
    owner_id: str
    owner_name: str
    folder_id: str | None
    folder_name: str | None
    permissions: list[str]
    allow_overwrite: bool
    is_active: bool
    last_used_at: datetime | None
    expires_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApiKeyCreateResponse(ApiKeyResponse):
    plaintext_key: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _key_response(key: ApiKey) -> ApiKeyResponse:
    return ApiKeyResponse(
        id=str(key.id),
        name=key.name,
        key_prefix=key.key_prefix,
        owner_id=str(key.owner_id),
        owner_name=key.owner.display_name or key.owner.username,
        folder_id=str(key.folder_id) if key.folder_id else None,
        folder_name=key.folder.name if key.folder else None,
        permissions=[p.strip() for p in key.permissions.split(",") if p.strip()],
        allow_overwrite=key.allow_overwrite,
        is_active=key.is_active,
        last_used_at=key.last_used_at,
        expires_at=key.expires_at,
        created_at=key.created_at,
    )


def _validate_permissions(perms: list[str]) -> str:
    invalid = set(perms) - VALID_PERMISSIONS
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid permissions: {invalid}. Valid: {VALID_PERMISSIONS}",
        )
    return ",".join(perms)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=list[ApiKeyResponse])
async def list_api_keys(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(
        select(ApiKey).order_by(ApiKey.created_at.desc())
    )
    keys = result.scalars().all()
    return [_key_response(k) for k in keys]


@router.post("", response_model=ApiKeyCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    body: ApiKeyCreate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    # Validate owner exists
    owner_result = await db.execute(
        select(User).where(User.id == uuid.UUID(body.owner_id))
    )
    owner = owner_result.scalar_one_or_none()
    if owner is None:
        raise HTTPException(status_code=404, detail="Owner user not found")

    # Validate folder if specified
    folder_id = None
    if body.folder_id:
        folder_result = await db.execute(
            select(Folder).where(Folder.id == uuid.UUID(body.folder_id))
        )
        if folder_result.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        folder_id = uuid.UUID(body.folder_id)

    permissions_str = _validate_permissions(body.permissions)

    # Generate key
    plaintext_key = f"las_{secrets.token_urlsafe(48)}"
    key_hash = hashlib.sha256(plaintext_key.encode()).hexdigest()
    key_prefix = plaintext_key[:12]

    api_key = ApiKey(
        name=body.name,
        key_hash=key_hash,
        key_prefix=key_prefix,
        owner_id=uuid.UUID(body.owner_id),
        folder_id=folder_id,
        permissions=permissions_str,
        allow_overwrite=body.allow_overwrite,
        expires_at=body.expires_at,
    )
    db.add(api_key)
    await db.flush()
    await db.refresh(api_key)

    resp = _key_response(api_key)
    return ApiKeyCreateResponse(
        **resp.model_dump(),
        plaintext_key=plaintext_key,
    )


@router.patch("/{key_id}", response_model=ApiKeyResponse)
async def update_api_key(
    key_id: uuid.UUID,
    body: ApiKeyUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(ApiKey).where(ApiKey.id == key_id))
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise HTTPException(status_code=404, detail="API key not found")

    if body.name is not None:
        api_key.name = body.name
    if body.folder_id is not None:
        folder_result = await db.execute(
            select(Folder).where(Folder.id == uuid.UUID(body.folder_id))
        )
        if folder_result.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        api_key.folder_id = uuid.UUID(body.folder_id)
    if body.permissions is not None:
        api_key.permissions = _validate_permissions(body.permissions)
    if body.allow_overwrite is not None:
        api_key.allow_overwrite = body.allow_overwrite
    if body.is_active is not None:
        api_key.is_active = body.is_active
    if body.expires_at is not None:
        api_key.expires_at = body.expires_at

    await db.flush()
    await db.refresh(api_key)
    return _key_response(api_key)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_api_key(
    key_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(ApiKey).where(ApiKey.id == key_id))
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise HTTPException(status_code=404, detail="API key not found")
    await db.delete(api_key)
