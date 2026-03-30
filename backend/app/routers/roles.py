from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import require_permission
from app.models import Role, User
from app.services.audit import audit_log

router = APIRouter(prefix="/roles", tags=["roles"])


class RoleCreate(BaseModel):
    name: str
    permissions: list[str]


class RoleResponse(BaseModel):
    id: int
    name: str
    permissions: list[str]
    created_at: datetime

    model_config = {"from_attributes": True}


@router.get("", response_model=list[RoleResponse])
async def list_roles(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(Role).order_by(Role.name))
    roles = result.scalars().all()
    return [
        RoleResponse(
            id=r.id,
            name=r.name,
            permissions=[p.strip() for p in r.permissions.split(",") if p.strip()] if r.permissions else [],
            created_at=r.created_at,
        )
        for r in roles
    ]


@router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
async def create_role(
    body: RoleCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    existing = await db.execute(select(Role).where(Role.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Role already exists")

    role = Role(
        name=body.name,
        permissions=",".join(body.permissions),
    )
    db.add(role)
    await db.flush()
    await db.refresh(role)

    await audit_log(db, user=_admin, action="role.create", target_type="role",
                    target_id=str(role.id), target_name=role.name,
                    detail={"permissions": body.permissions}, request=request)

    return RoleResponse(
        id=role.id,
        name=role.name,
        permissions=body.permissions,
        created_at=role.created_at,
    )


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found")
    role_name = role.name
    await db.delete(role)
    await audit_log(db, user=_admin, action="role.delete", target_type="role",
                    target_id=str(role_id), target_name=role_name, request=request)
