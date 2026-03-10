import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import Document, Folder, User

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


class FolderResponse(BaseModel):
    id: str
    name: str
    parent_id: str | None
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


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[FolderResponse])
async def list_folders(
    tree: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all folders with document counts."""
    doc_count_sq = (
        select(
            Document.folder_id,
            func.count(Document.id).label("doc_count"),
        )
        .where(Document.folder_id.is_not(None))
        .group_by(Document.folder_id)
        .subquery()
    )

    stmt = (
        select(
            Folder.id,
            Folder.name,
            Folder.parent_id,
            Folder.created_at,
            Folder.updated_at,
            func.coalesce(doc_count_sq.c.doc_count, 0).label("document_count"),
        )
        .outerjoin(doc_count_sq, Folder.id == doc_count_sq.c.folder_id)
        .order_by(Folder.name)
    )

    result = await db.execute(stmt)
    rows = result.all()

    items = [
        {
            "id": str(row.id),
            "name": row.name,
            "parent_id": str(row.parent_id) if row.parent_id else None,
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

    folder = Folder(name=body.name, parent_id=parent_uuid)
    db.add(folder)
    await db.flush()
    await db.refresh(folder)

    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
        document_count=0,
        created_at=folder.created_at.isoformat(),
        updated_at=folder.updated_at.isoformat(),
    )


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

    await db.flush()
    await db.refresh(folder)

    doc_count = (
        await db.execute(
            select(func.count(Document.id)).where(Document.folder_id == folder_id)
        )
    ).scalar() or 0

    return FolderResponse(
        id=str(folder.id),
        name=folder.name,
        parent_id=str(folder.parent_id) if folder.parent_id else None,
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
    """Delete a folder. Documents inside get folder_id = NULL. Child folders are cascade deleted."""
    folder = await db.get(Folder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")

    # Unset folder_id for documents in this folder and all descendant folders
    async def _collect_ids(fid: uuid.UUID) -> list[uuid.UUID]:
        ids = [fid]
        children = await db.execute(
            select(Folder.id).where(Folder.parent_id == fid)
        )
        for (child_id,) in children.all():
            ids.extend(await _collect_ids(child_id))
        return ids

    all_folder_ids = await _collect_ids(folder_id)
    for fid in all_folder_ids:
        await db.execute(
            Document.__table__.update()
            .where(Document.folder_id == fid)
            .values(folder_id=None)
        )

    await db.delete(folder)
