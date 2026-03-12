"""Unix-style permission utilities for documents and folders.

Permission model:
  - owner: always rw (fixed)
  - group: group_read / group_write (if user is a member of the document's group)
  - others: others_read / others_write
  - admin: full access to everything (like root)
"""

import uuid

from sqlalchemy import or_, select, literal
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from app.models import Document, Folder, Group, GroupMember, User


def is_admin(user: User) -> bool:
    """Check if user has the 'admin' permission via any of their roles."""
    for ur in user.roles:
        if ur.role.permissions and "admin" in [
            p.strip() for p in ur.role.permissions.split(",")
        ]:
            return True
    return False


async def get_user_group_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Return list of group IDs the user belongs to."""
    result = await db.execute(
        select(GroupMember.group_id).where(GroupMember.user_id == user_id)
    )
    return list(result.scalars().all())


async def can_access_document(
    doc: "Document",
    user: User,
    need_write: bool = False,
    db: AsyncSession | None = None,
) -> bool:
    """Check if user can access the document.

    - admin → always allowed
    - owner → always rw
    - group member → group_read / group_write
    - others → others_read / others_write
    """
    if is_admin(user):
        return True
    if doc.owner_id == user.id:
        return True

    # Check group permissions
    if doc.group_id and db is not None:
        group_ids = await get_user_group_ids(db, user.id)
        if doc.group_id in group_ids:
            if need_write:
                return doc.group_write
            return doc.group_read

    # Check others permissions
    if need_write:
        return doc.others_write
    return doc.others_read


async def can_access_folder(
    folder: "Folder",
    user: User,
    need_write: bool = False,
    db: AsyncSession | None = None,
) -> bool:
    """Check if user can access the folder (same logic as documents)."""
    if is_admin(user):
        return True
    if folder.owner_id == user.id:
        return True

    if folder.group_id and db is not None:
        group_ids = await get_user_group_ids(db, user.id)
        if folder.group_id in group_ids:
            if need_write:
                return folder.group_write
            return folder.group_read

    if need_write:
        return folder.others_write
    return folder.others_read


def build_visibility_filter(
    user: User, user_group_ids: list[uuid.UUID]
) -> ColumnElement[bool]:
    """Build a SQLAlchemy WHERE clause that filters documents by Unix permissions.

    For admin: returns literal True (no filter).
    For others: OR(owner, group member with group_read, others_read).
    """
    if is_admin(user):
        return literal(True)

    conditions = [
        Document.owner_id == user.id,
        Document.others_read.is_(True),
    ]
    if user_group_ids:
        conditions.append(
            (Document.group_id.in_(user_group_ids)) & (Document.group_read.is_(True))
        )
    return or_(*conditions)


def build_folder_visibility_filter(
    user: User, user_group_ids: list[uuid.UUID]
) -> ColumnElement[bool]:
    """Build a SQLAlchemy WHERE clause that filters folders by Unix permissions."""
    if is_admin(user):
        return literal(True)

    conditions = [
        Folder.owner_id == user.id,
        Folder.others_read.is_(True),
    ]
    if user_group_ids:
        conditions.append(
            (Folder.group_id.in_(user_group_ids)) & (Folder.group_read.is_(True))
        )
    return or_(*conditions)


def format_permission_string(
    group_read: bool,
    group_write: bool,
    others_read: bool,
    others_write: bool,
) -> str:
    """Format permissions as Unix-style string: rw-r--r-- (owner always rw)."""
    owner = "rw"
    group = ("r" if group_read else "-") + ("w" if group_write else "-")
    others = ("r" if others_read else "-") + ("w" if others_write else "-")
    return f"{owner}{group}{others}"
