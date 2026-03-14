import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db import get_db
from app.deps import get_current_user
from app.models import Chunk, Document, DocumentTag, Folder, Group, Tag, User
from app.services.permissions import build_visibility_filter, get_user_group_ids
from app.services.search import fulltext_search, merged_search, vector_search
from app.services.tokenizer import tokenize_query

router = APIRouter(prefix="/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    mode: str = Query("merged", regex="^(fulltext|vector|merged)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search documents using fulltext, vector, or merged (RRF) strategies."""
    offset = (page - 1) * per_page

    if mode == "fulltext":
        all_results = await fulltext_search(db, q, limit=per_page + offset, require_searchable=True, user=current_user)
        total = len(all_results)
        results = all_results[offset : offset + per_page]
    elif mode == "vector":
        all_results = await vector_search(db, q, limit=per_page + offset, require_searchable=True, user=current_user)
        total = len(all_results)
        results = all_results[offset : offset + per_page]
    else:
        results, total = await merged_search(db, q, limit=per_page, offset=offset, require_searchable=True, user=current_user)

    return {
        "query": q,
        "tokens": tokenize_query(q),
        "mode": mode,
        "page": page,
        "per_page": per_page,
        "total": total,
        "count": len(results),
        "results": results,
    }


@router.get("/documents")
async def search_documents_list(
    q: str = Query(..., min_length=1, description="Search query"),
    page: int = Query(1, ge=1),
    per_page: int = Query(30, ge=1, le=100),
    folder_id: str | None = Query(None),
    unfiled: bool = Query(False),
    tag: str | None = Query(None),
    file_type: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search documents and return document-level results with metadata."""
    from app.services.document_processing import load_tags_for_docs, make_doc_list_item

    offset = (page - 1) * per_page
    results, total = await merged_search(
        db, q, limit=per_page, offset=offset,
        require_searchable=True, user=current_user,
        folder_id=folder_id, unfiled=unfiled, tag=tag, file_type=file_type,
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

    stmt = (
        select(
            Document.id, Document.title, Document.source_path, Document.file_type,
            Document.owner_id, OwnerUser.username.label("owner_name"),
            Document.group_id, Document.group_read, Document.group_write,
            Document.others_read, Document.others_write,
            Document.searchable, Document.ai_knowledge, Document.summary,
            Document.memo, Document.folder_id, Folder.name.label("folder_name"),
            Group.name.label("group_name"),
            Document.created_at, Document.updated_at,
            func.coalesce(chunk_count_sq.c.chunk_count, 0).label("chunk_count"),
            CreatedByUser.username.label("created_by_name"),
            UpdatedByUser.username.label("updated_by_name"),
        )
        .outerjoin(chunk_count_sq, Document.id == chunk_count_sq.c.document_id)
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


@router.get("/stream")
async def search_stream(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint that streams an AI-generated answer based on search results.

    This is a placeholder that returns search context chunks via SSE.
    The actual LLM streaming will be wired up when the llama.cpp completion
    endpoint is integrated.
    """
    # First, get search results for context
    results, _ = await merged_search(db, q, limit=limit, require_searchable=True, user=current_user)

    async def event_generator():
        # Send context chunks
        context_parts = []
        for r in results:
            context_parts.append(r["content"])
            event_data = json.dumps(
                {
                    "type": "context",
                    "document_title": r["document_title"],
                    "chunk_id": r["chunk_id"],
                }
            )
            yield f"data: {event_data}\n\n"

        # Placeholder: stream a simple response indicating LLM integration pending
        # In production, this would call the LLM_URL /completion endpoint with
        # the search context and stream back tokens.
        yield f"data: {json.dumps({'type': 'answer_start'})}\n\n"

        placeholder_answer = (
            f"Found {len(results)} relevant chunks for query: '{q}'. "
            "LLM streaming will be connected to the llama.cpp server."
        )
        # Simulate token streaming
        for word in placeholder_answer.split():
            yield f"data: {json.dumps({'type': 'token', 'content': word + ' '})}\n\n"
            await asyncio.sleep(0.02)

        yield f"data: {json.dumps({'type': 'answer_end'})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
