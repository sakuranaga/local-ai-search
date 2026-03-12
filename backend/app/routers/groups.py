import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import Document, Folder, Group, GroupMember, User
from app.services.permissions import is_admin

router = APIRouter(prefix="/groups", tags=["groups"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class GroupCreate(BaseModel):
    name: str
    description: str = ""


class GroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class GroupResponse(BaseModel):
    id: str
    name: str
    description: str
    member_count: int
    created_at: str
    updated_at: str


class MemberResponse(BaseModel):
    user_id: str
    username: str
    display_name: str
    created_at: str


class MemberAdd(BaseModel):
    user_id: str


# ---------------------------------------------------------------------------
# Group CRUD
# ---------------------------------------------------------------------------


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List groups. Admin sees all; regular users see only groups they belong to."""
    member_count_sq = (
        select(
            GroupMember.group_id,
            func.count(GroupMember.id).label("member_count"),
        )
        .group_by(GroupMember.group_id)
        .subquery()
    )

    stmt = (
        select(
            Group.id,
            Group.name,
            Group.description,
            Group.created_at,
            Group.updated_at,
            func.coalesce(member_count_sq.c.member_count, 0).label("member_count"),
        )
        .outerjoin(member_count_sq, Group.id == member_count_sq.c.group_id)
    )

    if not is_admin(current_user):
        user_groups = select(GroupMember.group_id).where(
            GroupMember.user_id == current_user.id
        )
        stmt = stmt.where(Group.id.in_(user_groups))

    stmt = stmt.order_by(Group.name)
    result = await db.execute(stmt)
    rows = result.all()

    return [
        GroupResponse(
            id=str(row.id),
            name=row.name,
            description=row.description or "",
            member_count=row.member_count,
            created_at=row.created_at.isoformat(),
            updated_at=row.updated_at.isoformat(),
        )
        for row in rows
    ]


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new group. Admin only."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin required")

    existing = await db.execute(select(Group).where(Group.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Group name already exists")

    group = Group(name=body.name, description=body.description)
    db.add(group)
    await db.flush()
    await db.refresh(group)

    return GroupResponse(
        id=str(group.id),
        name=group.name,
        description=group.description or "",
        member_count=0,
        created_at=group.created_at.isoformat(),
        updated_at=group.updated_at.isoformat(),
    )


@router.patch("/{group_id}", response_model=GroupResponse)
async def update_group(
    group_id: uuid.UUID,
    body: GroupUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a group. Admin only."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin required")

    group = await db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    if body.name is not None:
        group.name = body.name
    if body.description is not None:
        group.description = body.description

    await db.flush()
    await db.refresh(group)

    member_count = (
        await db.execute(
            select(func.count(GroupMember.id)).where(GroupMember.group_id == group_id)
        )
    ).scalar() or 0

    return GroupResponse(
        id=str(group.id),
        name=group.name,
        description=group.description or "",
        member_count=member_count,
        created_at=group.created_at.isoformat(),
        updated_at=group.updated_at.isoformat(),
    )


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a group. Sets group_id=NULL on documents/folders. Admin only."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin required")

    group = await db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    # Nullify group_id on documents and folders
    await db.execute(
        update(Document).where(Document.group_id == group_id).values(group_id=None)
    )
    await db.execute(
        update(Folder).where(Folder.group_id == group_id).values(group_id=None)
    )

    await db.delete(group)


# ---------------------------------------------------------------------------
# Member management
# ---------------------------------------------------------------------------


@router.get("/{group_id}/members", response_model=list[MemberResponse])
async def list_members(
    group_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List members of a group."""
    group = await db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    stmt = (
        select(
            GroupMember.user_id,
            User.username,
            User.display_name,
            GroupMember.created_at,
        )
        .join(User, GroupMember.user_id == User.id)
        .where(GroupMember.group_id == group_id)
        .order_by(User.username)
    )
    result = await db.execute(stmt)
    rows = result.all()

    return [
        MemberResponse(
            user_id=str(row.user_id),
            username=row.username,
            display_name=row.display_name or "",
            created_at=row.created_at.isoformat(),
        )
        for row in rows
    ]


@router.post("/{group_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    group_id: uuid.UUID,
    body: MemberAdd,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a user to a group. Admin only."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin required")

    group = await db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    user_id = uuid.UUID(body.user_id)
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Check if already a member
    existing = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="User is already a member")

    db.add(GroupMember(group_id=group_id, user_id=user_id))
    await db.flush()
    return {"status": "ok"}


@router.delete("/{group_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a user from a group. Admin only."""
    if not is_admin(current_user):
        raise HTTPException(status_code=403, detail="Admin required")

    result = await db.execute(
        select(GroupMember).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == user_id,
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")

    await db.delete(member)
