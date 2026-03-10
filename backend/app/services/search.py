import uuid

from sqlalchemy import func, literal_column, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document
from app.services.embedding import get_embedding


async def fulltext_search(
    db: AsyncSession, query: str, limit: int = 20,
    require_searchable: bool = False, require_ai_knowledge: bool = False,
) -> list[dict]:
    """Full-text search using SQL LIKE with pg_bigm GIN index acceleration.

    pg_bigm automatically accelerates LIKE queries through GIN indexes,
    so a plain LIKE is sufficient -- no special operators needed.
    """
    like_pattern = f"%{query}%"

    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.chunk_index,
            Chunk.content,
            Document.title.label("document_title"),
            Document.file_type,
        )
        .join(Document, Chunk.document_id == Document.id)
        .where(Chunk.content.ilike(like_pattern))
        .where(Document.deleted_at.is_(None))
    )
    if require_searchable:
        stmt = stmt.where(Document.searchable.is_(True))
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        {
            "chunk_id": str(row.id),
            "document_id": str(row.document_id),
            "chunk_index": row.chunk_index,
            "content": row.content,
            "document_title": row.document_title,
            "file_type": row.file_type,
            "source": "fulltext",
        }
        for row in rows
    ]


async def vector_search(
    db: AsyncSession, query: str, limit: int = 20,
    require_searchable: bool = False, require_ai_knowledge: bool = False,
) -> list[dict]:
    """Semantic search using pgvector cosine distance (<=>)."""
    query_embedding = await get_embedding(query)

    # Use pgvector cosine distance operator
    distance = Chunk.embedding.cosine_distance(query_embedding).label("distance")

    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.chunk_index,
            Chunk.content,
            Document.title.label("document_title"),
            Document.file_type,
            distance,
        )
        .join(Document, Chunk.document_id == Document.id)
        .where(Chunk.embedding.is_not(None))
        .where(Document.deleted_at.is_(None))
    )
    if require_searchable:
        stmt = stmt.where(Document.searchable.is_(True))
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    stmt = stmt.order_by(distance).limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        {
            "chunk_id": str(row.id),
            "document_id": str(row.document_id),
            "chunk_index": row.chunk_index,
            "content": row.content,
            "document_title": row.document_title,
            "file_type": row.file_type,
            "distance": float(row.distance),
            "source": "vector",
        }
        for row in rows
    ]


async def merged_search(
    db: AsyncSession,
    query: str,
    limit: int = 20,
    offset: int = 0,
    max_candidates: int = 200,
    require_searchable: bool = False,
    require_ai_knowledge: bool = False,
) -> tuple[list[dict], int]:
    """Reciprocal Rank Fusion (RRF) merge of fulltext and vector search results.

    RRF score = sum(1 / (k + rank_i)) for each ranking list.
    k = 60 is the standard constant.

    Returns (results_page, total_count) with document-level dedup.
    """
    import asyncio

    ft_results, vec_results = await asyncio.gather(
        fulltext_search(db, query, limit=max_candidates, require_searchable=require_searchable, require_ai_knowledge=require_ai_knowledge),
        vector_search(db, query, limit=max_candidates, require_searchable=require_searchable, require_ai_knowledge=require_ai_knowledge),
    )

    k = 60
    scores: dict[str, float] = {}
    chunk_map: dict[str, dict] = {}

    # Score fulltext results by position
    for rank, item in enumerate(ft_results, start=1):
        cid = item["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
        if cid not in chunk_map:
            chunk_map[cid] = item

    # Score vector results by position
    for rank, item in enumerate(vec_results, start=1):
        cid = item["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
        if cid not in chunk_map:
            chunk_map[cid] = item

    # Sort by RRF score descending
    ranked_ids = sorted(scores.keys(), key=lambda cid: scores[cid], reverse=True)

    # Deduplicate by document — keep the highest-scoring chunk per document
    seen_docs: set[str] = set()
    all_results = []
    for cid in ranked_ids:
        item = chunk_map[cid]
        doc_id = item["document_id"]
        if doc_id in seen_docs:
            continue
        seen_docs.add(doc_id)
        entry = item.copy()
        entry["rrf_score"] = scores[cid]
        entry["source"] = "merged"
        all_results.append(entry)

    total = len(all_results)
    page = all_results[offset : offset + limit]
    return page, total
