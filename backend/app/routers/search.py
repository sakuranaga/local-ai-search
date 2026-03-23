import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db import get_db
from app.deps import get_current_user
from app.models import Chunk, Document, File, Folder, Group, Tag, User
from app.services.search import merged_search
from app.services.tokenizer import tokenize_query

router = APIRouter(prefix="/search", tags=["search"])


@router.get("/documents")
async def search_documents_list(
    q: str = Query(..., min_length=1, description="Search query"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=100),
    folder_id: str | None = Query(None),
    unfiled: bool = Query(False),
    tags: str | None = Query(None, description="Comma-separated tag names (AND filter)"),
    file_type: str | None = Query(None),
    include_unsearchable: bool = Query(False, description="Include documents with searchable=OFF"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search documents and return document-level results with metadata."""
    from app.services.document_processing import load_tags_for_docs, make_doc_list_item

    offset = (page - 1) * per_page
    results, total = await merged_search(
        db, q, limit=per_page, offset=offset,
        require_searchable=not include_unsearchable, user=current_user,
        folder_id=folder_id, unfiled=unfiled, tags=tags, file_type=file_type,
    )

    doc_ids_ordered = [uuid.UUID(r["document_id"]) for r in results]
    rrf_scores = {r["document_id"]: r.get("rrf_score", 0) for r in results}

    if not doc_ids_ordered:
        return {
            "items": [],
            "total": total,
            "page": page,
            "per_page": per_page,
            "tokens": tokenize_query(q),
        }

    # Fetch full document metadata for the result IDs
    CreatedByUser = aliased(User)
    UpdatedByUser = aliased(User)
    OwnerUser = aliased(User)

    chunk_count_sq = (
        select(Chunk.document_id, func.count(Chunk.id).label("chunk_count"))
        .group_by(Chunk.document_id)
        .subquery()
    )

    file_size_sq = (
        select(File.document_id, func.sum(File.file_size).label("file_size"))
        .group_by(File.document_id)
        .subquery()
    )

    stmt = (
        select(
            Document.id, Document.title, Document.source_path, Document.file_type,
            Document.owner_id, func.coalesce(func.nullif(OwnerUser.display_name, ""), OwnerUser.username).label("owner_name"),
            Document.group_id, Document.group_read, Document.group_write,
            Document.others_read, Document.others_write,
            Document.searchable, Document.ai_knowledge, Document.summary,
            Document.is_note,
            Document.memo, Document.folder_id, Folder.name.label("folder_name"),
            Group.name.label("group_name"),
            Document.created_at, Document.updated_at,
            file_size_sq.c.file_size.label("file_size"),
            func.coalesce(chunk_count_sq.c.chunk_count, 0).label("chunk_count"),
            func.coalesce(func.nullif(CreatedByUser.display_name, ""), CreatedByUser.username).label("created_by_name"),
            func.coalesce(func.nullif(UpdatedByUser.display_name, ""), UpdatedByUser.username).label("updated_by_name"),
        )
        .outerjoin(chunk_count_sq, Document.id == chunk_count_sq.c.document_id)
        .outerjoin(file_size_sq, Document.id == file_size_sq.c.document_id)
        .outerjoin(CreatedByUser, Document.created_by_id == CreatedByUser.id)
        .outerjoin(UpdatedByUser, Document.updated_by_id == UpdatedByUser.id)
        .outerjoin(OwnerUser, Document.owner_id == OwnerUser.id)
        .outerjoin(Folder, Document.folder_id == Folder.id)
        .outerjoin(Group, Document.group_id == Group.id)
        .where(Document.id.in_(doc_ids_ordered))
        .where(Document.deleted_at.is_(None))
    )
    result = await db.execute(stmt)
    rows = result.all()

    # Build lookup by ID
    row_map = {row.id: row for row in rows}

    # Batch-load tags
    tags_map = await load_tags_for_docs(db, doc_ids_ordered)

    # Build items in RRF score order
    items = []
    for doc_id in doc_ids_ordered:
        row = row_map.get(doc_id)
        if not row:
            continue
        item = make_doc_list_item(row, tags=tags_map.get(doc_id, []))
        item_dict = item.model_dump()
        item_dict["rrf_score"] = rrf_scores.get(str(doc_id), 0)
        items.append(item_dict)

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "tokens": tokenize_query(q),
    }
