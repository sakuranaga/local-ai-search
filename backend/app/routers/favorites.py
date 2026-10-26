import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Document, UserFavorite, User
from app.routers.auth import get_current_user
from app.services.permissions import build_visibility_filter, can_access_document, get_user_group_ids

router = APIRouter(prefix="/favorites", tags=["favorites"])


@router.get("")
async def list_favorites(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return list of favorited document IDs for current user (those the user may read now, not in the trash)."""
    group_ids = await get_user_group_ids(db, current_user.id)
    stmt = (
        select(UserFavorite.document_id)
        .join(Document, Document.id == UserFavorite.document_id)
        .where(UserFavorite.user_id == current_user.id)
        .where(build_visibility_filter(current_user, group_ids), Document.deleted_at.is_(None))
        .order_by(UserFavorite.created_at.desc())
    )
    result = await db.execute(stmt)
    return [str(row[0]) for row in result.all()]


@router.post("/{document_id}", status_code=status.HTTP_201_CREATED)
async def add_favorite(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a document to favorites."""
    doc_uuid = uuid.UUID(document_id)
    # Verify document exists
    doc = await db.get(Document, doc_uuid)
    # one not readable, or in the trash, is as one not there: its existence is not told
    if not doc or doc.deleted_at is not None or not await can_access_document(doc, current_user, db=db):
        raise HTTPException(status_code=404, detail="Document not found")

    # Check if already favorited
    existing = await db.execute(
        select(UserFavorite).where(
            UserFavorite.user_id == current_user.id,
            UserFavorite.document_id == doc_uuid,
        )
    )
    if existing.scalar_one_or_none():
        return {"status": "already_exists"}

    fav = UserFavorite(user_id=current_user.id, document_id=doc_uuid)
    db.add(fav)
    await db.commit()
    return {"status": "added"}


@router.delete("/{document_id}")
async def remove_favorite(
    document_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a document from favorites."""
    doc_uuid = uuid.UUID(document_id)
    await db.execute(
        delete(UserFavorite).where(
            UserFavorite.user_id == current_user.id,
            UserFavorite.document_id == doc_uuid,
        )
    )
    await db.commit()
    return {"status": "removed"}
