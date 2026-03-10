from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import DocumentTag, Tag, User

router = APIRouter(prefix="/tags", tags=["tags"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class TagCreate(BaseModel):
    name: str
    color: str | None = None


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class TagResponse(BaseModel):
    id: int
    name: str
    color: str | None
    document_count: int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=list[TagResponse])
async def list_tags(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc_count_sq = (
        select(
            DocumentTag.tag_id,
            func.count(DocumentTag.document_id).label("doc_count"),
        )
        .group_by(DocumentTag.tag_id)
        .subquery()
    )

    stmt = (
        select(
            Tag.id,
            Tag.name,
            Tag.color,
            func.coalesce(doc_count_sq.c.doc_count, 0).label("document_count"),
        )
        .outerjoin(doc_count_sq, Tag.id == doc_count_sq.c.tag_id)
        .order_by(Tag.name)
    )

    result = await db.execute(stmt)
    return [
        TagResponse(id=row.id, name=row.name, color=row.color, document_count=row.document_count)
        for row in result.all()
    ]


@router.post("", response_model=TagResponse, status_code=status.HTTP_201_CREATED)
async def create_tag(
    body: TagCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Check duplicate
    existing = await db.execute(select(Tag).where(Tag.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Tag already exists")

    tag = Tag(name=body.name, color=body.color)
    db.add(tag)
    await db.flush()
    await db.refresh(tag)

    return TagResponse(id=tag.id, name=tag.name, color=tag.color, document_count=0)


@router.patch("/{tag_id}", response_model=TagResponse)
async def update_tag(
    tag_id: int,
    body: TagUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tag = await db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")

    if body.name is not None:
        tag.name = body.name
    if body.color is not None:
        tag.color = body.color

    await db.flush()
    await db.refresh(tag)

    doc_count = (
        await db.execute(
            select(func.count(DocumentTag.id)).where(DocumentTag.tag_id == tag_id)
        )
    ).scalar() or 0

    return TagResponse(id=tag.id, name=tag.name, color=tag.color, document_count=doc_count)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(
    tag_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tag = await db.get(Tag, tag_id)
    if tag is None:
        raise HTTPException(status_code=404, detail="Tag not found")

    await db.delete(tag)
