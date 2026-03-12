import uuid

from sqlalchemy import case, func, literal_column, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from app.models import Chunk, Document, User
from app.services.embedding import get_embedding
from app.services.permissions import build_visibility_filter, get_user_group_ids, is_admin
from app.services.settings import get_setting
from app.services.tokenizer import tokenize_query


async def _get_visibility_filter(
    db: AsyncSession, user: User | None
) -> ColumnElement[bool]:
    """Build visibility filter for a user. If user is None, no filter."""
    if user is None:
        from sqlalchemy import literal
        return literal(True)
    user_group_ids = await get_user_group_ids(db, user.id)
    return build_visibility_filter(user, user_group_ids)


async def fulltext_search(
    db: AsyncSession, query: str, limit: int = 20,
    require_searchable: bool = False, require_ai_knowledge: bool = False,
    user: User | None = None,
) -> list[dict]:
    """Full-text search using SQL LIKE with pg_bigm GIN index acceleration."""
    words = tokenize_query(query)
    if not words:
        return []

    like_conditions = [Chunk.content.ilike(f"%{word}%") for word in words]
    match_count = sum(
        case((Chunk.content.ilike(f"%{w}%"), 1), else_=0) for w in words
    ).label("match_count")

    visibility = await _get_visibility_filter(db, user)

    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.chunk_index,
            Chunk.content,
            Document.title.label("document_title"),
            Document.file_type,
            Document.summary.label("document_summary"),
            Document.updated_at.label("document_updated_at"),
            match_count,
        )
        .join(Document, Chunk.document_id == Document.id)
        .where(Document.deleted_at.is_(None))
        .where(or_(*like_conditions))
        .where(visibility)
    )
    if require_searchable:
        stmt = stmt.where(Document.searchable.is_(True))
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    stmt = stmt.order_by(match_count.desc()).limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        {
            "chunk_id": str(row.id),
            "document_id": str(row.document_id),
            "chunk_index": row.chunk_index,
            "content": row.content,
            "document_title": row.document_title,
            "document_summary": row.document_summary,
            "file_type": row.file_type,
            "updated_at": row.document_updated_at.isoformat() if row.document_updated_at else None,
            "source": "fulltext",
        }
        for row in rows
    ]


async def vector_search(
    db: AsyncSession, query: str, limit: int = 20,
    require_searchable: bool = False, require_ai_knowledge: bool = False,
    user: User | None = None,
) -> list[dict]:
    """Semantic search using pgvector cosine distance (<=>)."""
    query_embedding = await get_embedding(query)

    threshold_pct = float(await get_setting(db, "vector_similarity_threshold") or "70")
    max_distance = 1.0 - threshold_pct / 100.0

    distance = Chunk.embedding.cosine_distance(query_embedding).label("distance")

    visibility = await _get_visibility_filter(db, user)

    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.chunk_index,
            Chunk.content,
            Document.title.label("document_title"),
            Document.file_type,
            Document.summary.label("document_summary"),
            Document.updated_at.label("document_updated_at"),
            distance,
        )
        .join(Document, Chunk.document_id == Document.id)
        .where(Chunk.embedding.is_not(None))
        .where(Document.deleted_at.is_(None))
        .where(distance <= max_distance)
        .where(visibility)
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
            "document_summary": row.document_summary,
            "file_type": row.file_type,
            "updated_at": row.document_updated_at.isoformat() if row.document_updated_at else None,
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
    user: User | None = None,
) -> tuple[list[dict], int]:
    """Reciprocal Rank Fusion (RRF) merge of fulltext and vector search results."""
    import asyncio

    ft_results, vec_results = await asyncio.gather(
        fulltext_search(db, query, limit=max_candidates, require_searchable=require_searchable, require_ai_knowledge=require_ai_knowledge, user=user),
        vector_search(db, query, limit=max_candidates, require_searchable=require_searchable, require_ai_knowledge=require_ai_knowledge, user=user),
    )

    k = 60
    scores: dict[str, float] = {}
    chunk_map: dict[str, dict] = {}
    distances: dict[str, float] = {}

    for rank, item in enumerate(ft_results, start=1):
        cid = item["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
        if cid not in chunk_map:
            chunk_map[cid] = item

    for rank, item in enumerate(vec_results, start=1):
        cid = item["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
        if cid not in chunk_map:
            chunk_map[cid] = item
        if "distance" in item:
            distances[cid] = item["distance"]

    ranked_ids = sorted(scores.keys(), key=lambda cid: scores[cid], reverse=True)

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
        if cid in distances:
            entry["distance"] = distances[cid]
        entry["source"] = "merged"
        all_results.append(entry)

    total = len(all_results)
    page = all_results[offset : offset + limit]
    return page, total


async def title_search(
    db: AsyncSession, query: str, limit: int = 10,
    require_ai_knowledge: bool = False,
    user: User | None = None,
) -> list[dict]:
    """Search documents by title/filename using ILIKE."""
    words = query.split()
    if not words:
        return []

    visibility = await _get_visibility_filter(db, user)

    stmt = (
        select(
            Document.id,
            Document.title,
            Document.file_type,
        )
        .where(Document.deleted_at.is_(None))
        .where(visibility)
    )
    for word in words:
        stmt = stmt.where(Document.title.ilike(f"%{word}%"))
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    stmt = stmt.order_by(Document.updated_at.desc()).limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        {
            "document_id": str(row.id),
            "title": row.title,
            "file_type": row.file_type,
        }
        for row in rows
    ]


async def grep_search(
    db: AsyncSession, pattern: str, limit: int = 10,
    require_ai_knowledge: bool = False,
    user: User | None = None,
) -> list[dict]:
    """Exact text pattern search across all chunk content."""
    if not pattern.strip():
        return []

    visibility = await _get_visibility_filter(db, user)

    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.content,
            Document.title.label("document_title"),
            Document.file_type,
        )
        .join(Document, Chunk.document_id == Document.id)
        .where(Chunk.content.ilike(f"%{pattern}%"))
        .where(Document.deleted_at.is_(None))
        .where(visibility)
    )
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        {
            "chunk_id": str(row.id),
            "document_id": str(row.document_id),
            "document_title": row.document_title,
            "file_type": row.file_type,
            "content": row.content[:300],
        }
        for row in rows
    ]
