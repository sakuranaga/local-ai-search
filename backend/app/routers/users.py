import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import Role, User, UserRole
from app.services.audit import audit_log
from app.services.auth import hash_password

router = APIRouter(prefix="/users", tags=["users"])


class UserCreate(BaseModel):
    username: str
    email: str = ""
    password: str
    display_name: str = ""
    role: str = ""  # convenience: assign a single role by name


class UserUpdate(BaseModel):
    username: str | None = None
    email: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    password: str | None = None
    is_active: bool | None = None
    can_share: bool | None = None
    can_download: bool | None = None
    role: str | None = None  # convenience: reassign role by name


class UserResponse(BaseModel):
    id: str
    username: str
    email: str
    display_name: str
    avatar_url: str | None
    is_active: bool
    can_share: bool
    can_download: bool
    roles: list[str]
    created_at: datetime

    model_config = {"from_attributes": True}


class RoleAssignment(BaseModel):
    role_ids: list[int]


def _user_response(u: User) -> UserResponse:
    return UserResponse(
        id=str(u.id),
        username=u.username,
        email=u.email,
        display_name=u.display_name or "",
        avatar_url=u.avatar_url,
        is_active=u.is_active,
        can_share=u.can_share,
        can_download=u.can_download,
        roles=[ur.role.name for ur in u.roles],
        created_at=u.created_at,
    )


@router.get("", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [_user_response(u) for u in users]


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    email = body.email or f"{body.username}@local"
    existing = await db.execute(
        select(User).where(
            (User.username == body.username) | (User.email == email)
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already exists",
        )

    user = User(
        username=body.username,
        email=email,
        display_name=body.display_name or body.username,
        hashed_password=hash_password(body.password),
    )
    db.add(user)
    await db.flush()

    # Assign role by name if provided
    if body.role:
        role_result = await db.execute(select(Role).where(Role.name == body.role))
        role = role_result.scalar_one_or_none()
        if role:
            db.add(UserRole(user_id=user.id, role_id=role.id))
            await db.flush()

    await db.refresh(user)
    await audit_log(db, user=_admin, action="user.create", target_type="user",
                    target_id=str(user.id), target_name=user.username,
                    detail={"role": body.role or None}, request=request)
    return _user_response(user)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_response(user)


@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if body.username is not None:
        user.username = body.username
    if body.email is not None:
        user.email = body.email
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url if body.avatar_url else None
    if body.password is not None:
        user.hashed_password = hash_password(body.password)
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.can_share is not None:
        user.can_share = body.can_share
    if body.can_download is not None:
        user.can_download = body.can_download

    # Reassign role by name
    if body.role is not None:
        await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
        if body.role:
            role_result = await db.execute(select(Role).where(Role.name == body.role))
            role = role_result.scalar_one_or_none()
            if role:
                db.add(UserRole(user_id=user.id, role_id=role.id))

    changed = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "password"}
    if body.password is not None:
        changed["password"] = "***changed***"

    await db.flush()
    await db.refresh(user)
    await audit_log(db, user=_admin, action="user.update", target_type="user",
                    target_id=str(user.id), target_name=user.username,
                    detail=changed, request=request)
    return _user_response(user)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    await audit_log(db, user=_admin, action="user.delete", target_type="user",
                    target_id=str(user_id), target_name=user.username, request=request)
    await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
    await db.delete(user)


@router.put("/{user_id}/roles", response_model=UserResponse)
async def assign_roles(
    user_id: uuid.UUID,
    body: RoleAssignment,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    roles_result = await db.execute(select(Role).where(Role.id.in_(body.role_ids)))
    found_roles = {r.id for r in roles_result.scalars().all()}
    missing = set(body.role_ids) - found_roles
    if missing:
        raise HTTPException(status_code=400, detail=f"Role IDs not found: {missing}")

    await db.execute(delete(UserRole).where(UserRole.user_id == user_id))
    for role_id in body.role_ids:
        db.add(UserRole(user_id=user_id, role_id=role_id))

    await db.flush()
    await db.refresh(user)
    await audit_log(db, user=_admin, action="user.role_assign", target_type="user",
                    target_id=str(user_id), target_name=user.username,
                    detail={"role_ids": body.role_ids}, request=request)
    return _user_response(user)
