import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import Document, Folder, Group, User
from app.services.permissions import (
    build_folder_visibility_filter,
    build_visibility_filter,
    get_user_group_ids,
    is_admin,
)

router = APIRouter(prefix="/folders", tags=["folders"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class FolderCreate(BaseModel):
    name: str
    parent_id: str | None = None


class FolderUpdate(BaseModel):
    name: str | None = None
    parent_id: str | None = None  # "" to move to root
    # Unix permission fields
    owner_id: str | None = None
    group_id: str | None = None  # "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None
    recursive: bool = False  # apply perms to children + their docs


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: str | None
    owner_id: str | None = None
    owner_name: str | None = None
    group_id: str | None = None
    group_name: str | None = None
    group_read: bool = False
    group_write: bool = False
    others_read: bool = True
    others_write: bool = False
    document_count: int
    created_at: str
    updated_at: str


class FolderTreeNode(BaseModel):
    id: str
    name: str
    parent_id: str | None
    document_count: int
    children: list["FolderTreeNode"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_tree(
    folders: list[dict], parent_id: str | None = None
) -> list[dict]:
    """Build a nested tree from a flat list of folder dicts."""
    nodes = []
    for f in folders:
        if f["parent_id"] == parent_id:
            children = _build_tree(folders, f["id"])
            nodes.append({**f, "children": children})
    return nodes


async def _check_no_cycle(
    db: AsyncSession, folder_id: uuid.UUID, new_parent_id: uuid.UUID
) -> bool:
    """Return True if setting new_parent_id would NOT create a cycle."""
    current = new_parent_id
    visited = set()
    while current is not None:
        if current == folder_id:
            return False
        if current in visited:
            return False
        visited.add(current)
        result = await db.execute(
            select(Folder.parent_id).where(Folder.id == current)
        )
        row = result.one_or_none()
        if row is None:
            break
        current = row[0]
    return True


async def _apply_perms_to_docs(
    db: AsyncSession, folder_id: uuid.UUID, folder: Folder
):
    """Apply folder's permissions to all documents in the folder."""
    docs_result = await db.execute(
        select(Document).where(
            Document.folder_id == folder_id,
            Document.deleted_at.is_(None),
        )
    )
    for doc in docs_result.scalars().all():
        doc.group_id = folder.group_id
        doc.group_read = folder.group_read
        doc.group_write = folder.group_write
        doc.others_read = folder.others_read
        doc.others_write = folder.others_write


async def _apply_perms_recursive(
    db: AsyncSession, folder: Folder
):
    """Apply permissions to this folder's docs and recursively to child folders."""
    await _apply_perms_to_docs(db, folder.id, folder)

    children_result = await db.execute(
        select(Folder).where(Folder.parent_id == folder.id)
    )
    for child in children_result.scalars().all():
        child.group_id = folder.group_id
        child.group_read = folder.group_read
        child.group_write = folder.group_write
        child.others_read = folder.others_read
        child.others_write = folder.others_write
        await _apply_perms_recursive(db, child)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[FolderResponse])
async def list_folders(
    tree: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List folders visible to the current user with document counts."""
    user_group_ids = await get_user_group_ids(db, current_user.id)
    visibility_filter = build_folder_visibility_filter(current_user, user_group_ids)

    # Also filter doc counts by document visibility
    doc_visibility = build_visibility_filter(current_user, user_group_ids)

    doc_count_sq = (
        select(
            Document.folder_id,
            func.count(Document.id).label("doc_count"),
        )
        .where(Document.folder_id.is_not(None))
        .where(Document.deleted_at.is_(None))
        .where(doc_visibility)
        .group_by(Document.folder_id)
        .subquery()
    )

    from sqlalchemy.orm import aliased
    OwnerUser = aliased(User)

    stmt = (
        select(
            Folder.id,
            Folder.name,
            Folder.parent_id,
            Folder.owner_id,
            func.coalesce(OwnerUser.display_name, OwnerUser.username).label("owner_name"),
            Folder.group_id,
            Folder.group_read,
            Folder.group_write,
            Folder.others_read,
            Folder.others_write,
            Folder.created_at,
            Folder.updated_at,
            Group.name.label("group_name"),
            func.coalesce(doc_count_sq.c.doc_count, 0).label("document_count"),
        )
        .outerjoin(doc_count_sq, Folder.id == doc_count_sq.c.folder_id)
        .outerjoin(OwnerUser, Folder.owner_id == OwnerUser.id)
        .outerjoin(Group, Folder.group_id == Group.id)
        .where(visibility_filter)
        .order_by(Folder.name)
    )

    result = await db.execute(stmt)
    rows = result.all()

    items = [
        {
            "id": str(row.id),
            "name": row.name,
            "parent_id": str(row.parent_id) if row.parent_id else None,
            "owner_id": str(row.owner_id) if row.owner_id else None,
            "owner_name": row.owner_name,
            "group_id": str(row.group_id) if row.group_id else None,
            "group_name": row.group_name,
            "group_read": row.group_read or False,
            "group_write": row.group_write or False,
            "others_read": row.others_read if row.others_read is not None else True,
            "others_write": row.others_write or False,
            "document_count": row.document_count,
            "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat(),
        }
        for row in rows
    ]

    if tree:
        return _build_tree(items)

    return items


@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: FolderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    parent_uuid = None
    if body.parent_id:
        parent_uuid = uuid.UUID(body.parent_id)
        parent = await db.get(Folder, parent_uuid)
        if parent is None:
            raise HTTPException(status_code=404, detail="Parent folder not found")

    folder = Folder(
        name=body.name,
        parent_id=parent_uuid,
        owner_id=current_user.id,
    )
    db.add(folder)
    await db.flush()
    await db.refresh(folder)

    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
        owner_id=str(folder.owner_id) if folder.owner_id else None,
        owner_name=current_user.display_name or current_user.username,
        document_count=0,
        created_at=folder.created_at.isoformat(),
        updated_at=folder.updated_at.isoformat(),
    )


class BulkFolderCreate(BaseModel):
    paths: list[str]          # e.g. ["営業資料", "営業資料/見積書"]
    parent_id: str | None = None


@router.post("/bulk", status_code=status.HTTP_201_CREATED)
async def create_folders_bulk(
    body: BulkFolderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create folder hierarchy from a list of path strings.

    Each path is slash-separated (e.g. "営業資料/見積書").
    Existing folders with the same name under the same parent are reused.
    Returns a mapping of path → folder id.
    """
    root_parent: uuid.UUID | None = None
    if body.parent_id:
        root_parent = uuid.UUID(body.parent_id)
        if not await db.get(Folder, root_parent):
            raise HTTPException(status_code=404, detail="Parent folder not found")

    # Sort by depth so parents are created before children
    sorted_paths = sorted(set(body.paths), key=lambda p: p.count("/"))

    # Cache: "path" → folder_id (includes pre-existing folders)
    path_to_id: dict[str, str] = {}

    for path in sorted_paths:
        parts = [p.strip() for p in path.split("/") if p.strip()]
        if not parts:
            continue

        current_parent = root_parent
        accumulated = ""

        for part in parts:
            accumulated = f"{accumulated}/{part}" if accumulated else part

            if accumulated in path_to_id:
                current_parent = uuid.UUID(path_to_id[accumulated])
                continue

            # Check if folder already exists under current parent
            existing = await db.execute(
                select(Folder).where(
                    Folder.name == part,
                    Folder.parent_id == current_parent,
                )
            )
            folder = existing.scalar_one_or_none()

            if folder:
                path_to_id[accumulated] = str(folder.id)
                current_parent = folder.id
            else:
                folder = Folder(
                    name=part,
                    parent_id=current_parent,
                    owner_id=current_user.id,
                )
                db.add(folder)
                await db.flush()
                await db.refresh(folder)
                path_to_id[accumulated] = str(folder.id)
                current_parent = folder.id

    await db.commit()

    return {
        "folders": [{"path": p, "id": fid} for p, fid in path_to_id.items()],
    }


@router.patch("/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: uuid.UUID,
    body: FolderUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = await db.get(Folder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Only owner or admin can update a folder
    if not is_admin(current_user) and folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only owner or admin can modify this folder")

    if body.name is not None:
        folder.name = body.name

    if body.parent_id is not None:
        if body.parent_id == "":
            folder.parent_id = None
        else:
            new_parent = uuid.UUID(body.parent_id)
            if not await _check_no_cycle(db, folder_id, new_parent):
                raise HTTPException(status_code=400, detail="Circular reference")
            folder.parent_id = new_parent

    # Permission fields (owner/admin only)
    perms_changed = False
    if body.owner_id is not None:
        folder.owner_id = uuid.UUID(body.owner_id) if body.owner_id else None
    if body.group_id is not None:
        folder.group_id = uuid.UUID(body.group_id) if body.group_id else None
        perms_changed = True
    if body.group_read is not None:
        folder.group_read = body.group_read
        perms_changed = True
    if body.group_write is not None:
        folder.group_write = body.group_write
        perms_changed = True
    if body.others_read is not None:
        folder.others_read = body.others_read
        perms_changed = True
    if body.others_write is not None:
        folder.others_write = body.others_write
        perms_changed = True

    # Apply permissions to documents in this folder
    if perms_changed:
        if body.recursive:
            await _apply_perms_recursive(db, folder)
        else:
            await _apply_perms_to_docs(db, folder_id, folder)

    await db.flush()
    await db.refresh(folder)

    doc_count = (
        await db.execute(
            select(func.count(Document.id)).where(Document.folder_id == folder_id, Document.deleted_at.is_(None))
        )
    ).scalar() or 0

    # Group name
    group_name = None
    if folder.group_id:
        r = await db.execute(select(Group.name).where(Group.id == folder.group_id))
        group_name = r.scalar_one_or_none()

    # Owner name
    owner_name = None
    if folder.owner_id:
        r = await db.execute(select(func.coalesce(User.display_name, User.username)).where(User.id == folder.owner_id))
        owner_name = r.scalar_one_or_none()

    from app.services.smb_notify import publish_cache_invalidate
    await publish_cache_invalidate(str(folder.parent_id) if folder.parent_id else None)
    await publish_cache_invalidate(str(folder.id))

    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
        owner_id=str(folder.owner_id) if folder.owner_id else None,
        owner_name=owner_name,
        group_id=str(folder.group_id) if folder.group_id else None,
        group_name=group_name,
        group_read=folder.group_read,
        group_write=folder.group_write,
        others_read=folder.others_read,
        others_write=folder.others_write,
        document_count=doc_count,
        created_at=folder.created_at.isoformat(),
        updated_at=folder.updated_at.isoformat(),
    )


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a folder. Documents inside are soft-deleted (moved to trash). Child folders are cascade deleted."""
    from datetime import datetime, timezone

    folder = await db.get(Folder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Only owner or admin can delete a folder
    if not is_admin(current_user) and folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only owner or admin can delete this folder")

    # Collect this folder and all descendant folder IDs
    async def _collect_ids(fid: uuid.UUID) -> list[uuid.UUID]:
        ids = [fid]
        children = await db.execute(
            select(Folder.id).where(Folder.parent_id == fid)
        )
        for (child_id,) in children.all():
            ids.extend(await _collect_ids(child_id))
        return ids

    all_folder_ids = await _collect_ids(folder_id)

    # Soft-delete (trash) all documents in these folders
    now = datetime.now(timezone.utc)
    for fid in all_folder_ids:
        await db.execute(
            Document.__table__.update()
            .where(Document.folder_id == fid)
            .where(Document.deleted_at.is_(None))
            .values(deleted_at=now, folder_id=None)
        )

    # Delete all descendant folders (deepest first), then the target folder
    parent_id_for_notify = folder.parent_id
    for fid in reversed(all_folder_ids):
        f = await db.get(Folder, fid)
        if f:
            await db.delete(f)

    from app.services.smb_notify import publish_cache_invalidate
    await publish_cache_invalidate(str(parent_id_for_notify) if parent_id_for_notify else None)
