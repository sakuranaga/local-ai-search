import uuid
from datetime import datetime, timezone

from sqlalchemy import case, func, literal_column, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import ColumnElement

from app.db import async_session
from app.models import Chunk, Document, DocumentTag, Folder, Tag, User
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
    folder_id: str | None = None, unfiled: bool = False,
    tags: str | None = None, file_type: str | None = None,
) -> list[dict]:
    """Full-text search using SQL LIKE with pg_bigm GIN index acceleration."""
    words = tokenize_query(query)
    if not words:
        return []

    def _content_like(col, word: str):
        """Use LIKE (not ILIKE) so pg_bigm GIN index is used on chunks.content.
        Search both original case and lowercase to emulate case-insensitivity."""
        conditions = [col.like(f"%{word}%")]
        lower_word = word.lower()
        if lower_word != word:
            conditions.append(col.like(f"%{lower_word}%"))
        upper_word = word.upper()
        if upper_word != word and upper_word != lower_word:
            conditions.append(col.like(f"%{upper_word}%"))
        return or_(*conditions)

    # CTE: pre-filter chunks using LIKE (triggers pg_bigm GIN index)
    # before joining with documents to avoid full table scan
    chunk_content_filter = or_(*[_content_like(Chunk.content, w) for w in words])
    chunk_cte = (
        select(Chunk.id, Chunk.document_id, Chunk.chunk_index, Chunk.content)
        .where(chunk_content_filter)
        .cte("matched_chunks")
    )

    # match_count: count how many query words match in content or title
    match_count = sum(
        case(
            (or_(_content_like(chunk_cte.c.content, w), Document.title.ilike(f"%{w}%")), 1),
            else_=0,
        )
        for w in words
    ).label("match_count")

    visibility = await _get_visibility_filter(db, user)

    stmt = (
        select(
            chunk_cte.c.id,
            chunk_cte.c.document_id,
            chunk_cte.c.chunk_index,
            chunk_cte.c.content,
            Document.title.label("document_title"),
            Document.file_type,
            Document.summary.label("document_summary"),
            Document.updated_at.label("document_updated_at"),
            match_count,
        )
        .join(Document, chunk_cte.c.document_id == Document.id)
        .where(Document.deleted_at.is_(None))
        .where(visibility)
    )
    if require_searchable:
        stmt = stmt.where(Document.searchable.is_(True))
    if require_ai_knowledge:
        stmt = stmt.where(Document.ai_knowledge.is_(True))
    if folder_id:
        stmt = stmt.where(Document.folder_id == uuid.UUID(folder_id))
    elif unfiled:
        stmt = stmt.where(Document.folder_id.is_(None))
    if file_type:
        stmt = stmt.where(Document.file_type == file_type)
    if tags:
        from app.models import DocumentTag, Tag
        for tag_name in [t.strip() for t in tags.split(",") if t.strip()]:
            tag_sq = (
                select(DocumentTag.document_id)
                .join(Tag, DocumentTag.tag_id == Tag.id)
                .where(Tag.name == tag_name)
                .subquery()
            )
            stmt = stmt.where(Document.id.in_(select(tag_sq.c.document_id)))
    stmt = stmt.order_by(match_count.desc()).limit(limit)

    result = await db.execute(stmt)
    rows = result.all()

    total_tokens = len(words)
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
            "match_count": row.match_count,
            "total_tokens": total_tokens,
            "source": "fulltext",
        }
        for row in rows
    ]


async def vector_search(
    db: AsyncSession, query: str, limit: int = 20,
    require_searchable: bool = False, require_ai_knowledge: bool = False,
    user: User | None = None,
    folder_id: str | None = None, unfiled: bool = False,
    tags: str | None = None, file_type: str | None = None,
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
    if folder_id:
        stmt = stmt.where(Document.folder_id == uuid.UUID(folder_id))
    elif unfiled:
        stmt = stmt.where(Document.folder_id.is_(None))
    if file_type:
        stmt = stmt.where(Document.file_type == file_type)
    if tags:
        from app.models import DocumentTag, Tag
        for tag_name in [t.strip() for t in tags.split(",") if t.strip()]:
            tag_sq = (
                select(DocumentTag.document_id)
                .join(Tag, DocumentTag.tag_id == Tag.id)
                .where(Tag.name == tag_name)
                .subquery()
            )
            stmt = stmt.where(Document.id.in_(select(tag_sq.c.document_id)))
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


# ---------------------------------------------------------------------------
# Metadata signals (title, filename, tag, memo, summary)
# ---------------------------------------------------------------------------

async def _metadata_signals(
    db: AsyncSession,
    words: list[str],
    visibility: ColumnElement[bool],
    require_searchable: bool = False,
    require_ai_knowledge: bool = False,
    folder_id: str | None = None,
    unfiled: bool = False,
    tags: str | None = None,
    file_type: str | None = None,
    limit: int = 200,
) -> dict[str, list[str]]:
    """Run metadata search signals and return {signal_name: [doc_id, ...]} ranked lists.

    Signals: title, filename, memo, summary, tag.
    Each list is ordered by match quality (match_count DESC, updated_at DESC).
    """
    if not words:
        return {"title": [], "filename": [], "memo": [], "summary": [], "tag": []}

    base_filters = [Document.deleted_at.is_(None), visibility]
    if require_searchable:
        base_filters.append(Document.searchable.is_(True))
    if require_ai_knowledge:
        base_filters.append(Document.ai_knowledge.is_(True))
    if folder_id:
        base_filters.append(Document.folder_id == uuid.UUID(folder_id))
    elif unfiled:
        base_filters.append(Document.folder_id.is_(None))
    if file_type:
        base_filters.append(Document.file_type == file_type)
    if tags:
        for tag_name in [t.strip() for t in tags.split(",") if t.strip()]:
            tag_sq = (
                select(DocumentTag.document_id)
                .join(Tag, DocumentTag.tag_id == Tag.id)
                .where(Tag.name == tag_name)
                .subquery()
            )
            base_filters.append(Document.id.in_(select(tag_sq.c.document_id)))

    results: dict[str, list[str]] = {}
    # Track per-document max match_count across all metadata signals
    doc_mc: dict[str, int] = {}
    total_words = len(words)

    # --- Title signal ---
    title_mc = sum(
        case((Document.title.ilike(f"%{w}%"), 1), else_=0) for w in words
    ).label("mc")
    title_where = [or_(Document.title.ilike(f"%{w}%") for w in words)]
    stmt = (
        select(Document.id, title_mc)
        .where(*base_filters, *title_where)
        .order_by(title_mc.desc(), Document.updated_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    results["title"] = [str(r.id) for r in rows]
    # Track docs where ALL tokens matched in title
    results["title_full"] = [str(r.id) for r in rows if r.mc >= total_words]
    for r in rows:
        did = str(r.id)
        doc_mc[did] = max(doc_mc.get(did, 0), r.mc)

    # --- Filename signal (source_path) ---
    fn_mc = sum(
        case((Document.source_path.ilike(f"%{w}%"), 1), else_=0) for w in words
    ).label("mc")
    fn_where = [
        Document.source_path.is_not(None),
        or_(Document.source_path.ilike(f"%{w}%") for w in words),
    ]
    stmt = (
        select(Document.id, fn_mc)
        .where(*base_filters, *fn_where)
        .order_by(fn_mc.desc(), Document.updated_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    results["filename"] = [str(r.id) for r in rows]
    for r in rows:
        did = str(r.id)
        doc_mc[did] = max(doc_mc.get(did, 0), r.mc)

    # --- Memo signal ---
    memo_mc = sum(
        case((Document.memo.ilike(f"%{w}%"), 1), else_=0) for w in words
    ).label("mc")
    memo_where = [
        Document.memo.is_not(None),
        or_(Document.memo.ilike(f"%{w}%") for w in words),
    ]
    stmt = (
        select(Document.id, memo_mc)
        .where(*base_filters, *memo_where)
        .order_by(memo_mc.desc(), Document.updated_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    results["memo"] = [str(r.id) for r in rows]
    for r in rows:
        did = str(r.id)
        doc_mc[did] = max(doc_mc.get(did, 0), r.mc)

    # --- Summary signal ---
    sum_mc = sum(
        case((Document.summary.ilike(f"%{w}%"), 1), else_=0) for w in words
    ).label("mc")
    sum_where = [
        Document.summary.is_not(None),
        or_(Document.summary.ilike(f"%{w}%") for w in words),
    ]
    stmt = (
        select(Document.id, sum_mc)
        .where(*base_filters, *sum_where)
        .order_by(sum_mc.desc(), Document.updated_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    results["summary"] = [str(r.id) for r in rows]
    for r in rows:
        did = str(r.id)
        doc_mc[did] = max(doc_mc.get(did, 0), r.mc)

    # --- Tag signal (needs SQL SUM because of GROUP BY on joined tags) ---
    tag_mc = func.sum(
        sum(
            case((Tag.name.ilike(f"%{w}%"), 1), else_=0) for w in words
        )
    ).label("mc")
    tag_where = [or_(Tag.name.ilike(f"%{w}%") for w in words)]
    stmt = (
        select(Document.id, tag_mc)
        .join(DocumentTag, Document.id == DocumentTag.document_id)
        .join(Tag, DocumentTag.tag_id == Tag.id)
        .where(*base_filters, *tag_where)
        .group_by(Document.id, Document.updated_at)
        .order_by(tag_mc.desc(), Document.updated_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    results["tag"] = [str(r.id) for r in rows]
    for r in rows:
        did = str(r.id)
        doc_mc[did] = max(doc_mc.get(did, 0), r.mc)

    return results, doc_mc


# ---------------------------------------------------------------------------
# Unified multi-signal search with weighted RRF + freshness
# ---------------------------------------------------------------------------

# Signal weights
_SIGNAL_WEIGHTS = {
    "title": 8.0,
    "title_full": 10.0,  # Bonus: all query tokens found in title
    "filename": 4.0,
    "tag": 3.0,
    "memo": 2.0,
    "summary": 2.0,
    "fulltext": 1.0,
    "vector": 6.0,
}
_FRESHNESS_WEIGHT = 0.2
_FRESHNESS_HALF_LIFE_DAYS = 30.0
_K = 60  # RRF constant
_TITLE_VECTOR_MAX_DISTANCE = 0.6  # Title embeddings are short text → need looser threshold


async def merged_search(
    db: AsyncSession,
    query: str,
    limit: int = 20,
    offset: int = 0,
    max_candidates: int = 200,
    require_searchable: bool = False,
    require_ai_knowledge: bool = False,
    user: User | None = None,
    folder_id: str | None = None, unfiled: bool = False,
    tags: str | None = None, file_type: str | None = None,
) -> tuple[list[dict], int]:
    """Unified multi-signal search with weighted RRF and freshness decay.

    8 signals: title, filename, tag, memo, summary, fulltext content,
    semantic vector, and freshness (time decay).
    Each signal runs on its own DB session for true parallel execution.
    """
    import asyncio

    filter_kwargs = dict(folder_id=folder_id, unfiled=unfiled, tags=tags, file_type=file_type)
    common_kwargs = dict(
        require_searchable=require_searchable,
        require_ai_knowledge=require_ai_knowledge,
    )

    async def run_metadata():
        async with async_session() as s:
            words = tokenize_query(query)
            visibility = await _get_visibility_filter(s, user)
            return await _metadata_signals(
                s, words, visibility, limit=max_candidates,
                **common_kwargs, **filter_kwargs,
            )

    async def run_fulltext():
        async with async_session() as s:
            return await fulltext_search(
                s, query, limit=max_candidates,
                user=user, **common_kwargs, **filter_kwargs,
            )

    async def run_title_vector():
        """Vector search on Document.title_embedding (title + filename)."""
        async with async_session() as s:
            query_embedding = await get_embedding(query)
            distance = Document.title_embedding.cosine_distance(query_embedding).label("distance")
            visibility = await _get_visibility_filter(s, user)
            stmt = (
                select(Document.id, Document.title, Document.file_type,
                       Document.summary, Document.updated_at, distance)
                .where(Document.title_embedding.is_not(None))
                .where(Document.deleted_at.is_(None))
                .where(distance <= _TITLE_VECTOR_MAX_DISTANCE)
                .where(visibility)
            )
            if common_kwargs.get("require_searchable"):
                stmt = stmt.where(Document.searchable.is_(True))
            if common_kwargs.get("require_ai_knowledge"):
                stmt = stmt.where(Document.ai_knowledge.is_(True))
            if folder_id:
                stmt = stmt.where(Document.folder_id == uuid.UUID(folder_id))
            elif unfiled:
                stmt = stmt.where(Document.folder_id.is_(None))
            if file_type:
                stmt = stmt.where(Document.file_type == file_type)
            if tags:
                for tag_name in [t.strip() for t in tags.split(",") if t.strip()]:
                    tag_sq = (
                        select(DocumentTag.document_id)
                        .join(Tag, DocumentTag.tag_id == Tag.id)
                        .where(Tag.name == tag_name)
                        .subquery()
                    )
                    stmt = stmt.where(Document.id.in_(select(tag_sq.c.document_id)))
            stmt = stmt.order_by(distance).limit(max_candidates)
            rows = (await s.execute(stmt)).all()
            return [
                {
                    "document_id": str(row.id),
                    "document_title": row.title,
                    "document_summary": row.summary,
                    "file_type": row.file_type,
                    "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                    "distance": float(row.distance),
                    "source": "title_vector",
                }
                for row in rows
            ]

    # True parallel execution on independent DB connections
    (meta_results, meta_doc_mc), ft_results, vec_results = await asyncio.gather(
        run_metadata(), run_fulltext(), run_title_vector(),
    )

    # --- Build per-document scores ---
    doc_scores: dict[str, float] = {}
    # Best chunk per document (for display)
    doc_best_chunk: dict[str, dict] = {}
    doc_distances: dict[str, float] = {}
    doc_updated_at: dict[str, str | None] = {}
    # Track best match_count per document for match-ratio penalty
    # Start with metadata signal match counts
    doc_match_count: dict[str, int] = dict(meta_doc_mc)

    words = tokenize_query(query)
    total_tokens = len(words) if words else 1

    # Metadata signals (already document-level)
    for signal_name in ("title", "title_full", "filename", "tag", "memo", "summary"):
        weight = _SIGNAL_WEIGHTS[signal_name]
        for rank, doc_id in enumerate(meta_results.get(signal_name, []), start=1):
            doc_scores[doc_id] = doc_scores.get(doc_id, 0.0) + weight / (_K + rank)

    # Fulltext signal (chunk-level → deduplicate to document, keep best rank)
    doc_ft_rank: dict[str, int] = {}
    for rank, item in enumerate(ft_results, start=1):
        doc_id = item["document_id"]
        if doc_id not in doc_ft_rank:
            doc_ft_rank[doc_id] = rank
        if doc_id not in doc_best_chunk:
            doc_best_chunk[doc_id] = item
            doc_updated_at[doc_id] = item.get("updated_at")
        # Track best match_count for this document
        mc = item.get("match_count", 0)
        if mc > doc_match_count.get(doc_id, 0):
            doc_match_count[doc_id] = mc
    for doc_id, rank in doc_ft_rank.items():
        doc_scores[doc_id] = doc_scores.get(doc_id, 0.0) + _SIGNAL_WEIGHTS["fulltext"] / (_K + rank)

    # Title vector signal (already document-level)
    doc_vec_rank: dict[str, int] = {}
    for rank, item in enumerate(vec_results, start=1):
        doc_id = item["document_id"]
        doc_vec_rank[doc_id] = rank
        if doc_id not in doc_best_chunk:
            doc_best_chunk[doc_id] = {
                "chunk_id": None,
                "document_id": doc_id,
                "chunk_index": 0,
                "content": "",
                "document_title": item.get("document_title"),
                "document_summary": item.get("document_summary"),
                "file_type": item.get("file_type"),
                "updated_at": item.get("updated_at"),
                "source": "title_vector",
            }
            doc_updated_at[doc_id] = item.get("updated_at")
        if "distance" in item:
            doc_distances[doc_id] = item["distance"]
    for doc_id, rank in doc_vec_rank.items():
        doc_scores[doc_id] = doc_scores.get(doc_id, 0.0) + _SIGNAL_WEIGHTS["vector"] / (_K + rank)

    # Match-ratio penalty: penalize documents that only match a fraction of query tokens
    # Uses squared ratio for aggressive penalty on low-match documents
    # 1/3 match → 0.33² = 0.11, 2/3 match → 0.67² = 0.44, 3/3 match → 1.0
    # Exception: vector-only hits (mc=0) keep their vector RRF score intact
    # because vector search is specifically for fuzzy/variant matching
    if total_tokens > 1:
        for doc_id in doc_scores:
            mc = doc_match_count.get(doc_id, 0)
            if mc == 0 and doc_id in doc_vec_rank:
                # Vector-only hit — no text match penalty, keep vector score as-is
                continue
            token_hits = min(mc, total_tokens)
            match_ratio = token_hits / total_tokens
            doc_scores[doc_id] *= match_ratio ** 2

    # Freshness signal (continuous decay, not RRF) — also scaled by match_ratio
    now = datetime.now(timezone.utc)
    for doc_id in doc_scores:
        updated_str = doc_updated_at.get(doc_id)
        if updated_str:
            try:
                updated = datetime.fromisoformat(updated_str)
                days_old = max(0, (now - updated).total_seconds() / 86400)
                freshness = 1.0 / (1.0 + days_old / _FRESHNESS_HALF_LIFE_DAYS)
                # Scale freshness by match_ratio² too — partial matches get much less freshness
                # Vector-only hits get no freshness boost (rely on vector RRF score alone)
                mc = doc_match_count.get(doc_id, 0)
                if mc == 0 and doc_id in doc_vec_rank:
                    mr = 0.0
                elif total_tokens > 1:
                    mr = min(mc, total_tokens) / total_tokens
                else:
                    mr = 1.0
                doc_scores[doc_id] += _FRESHNESS_WEIGHT * freshness * mr ** 2
            except (ValueError, TypeError):
                pass

    # For metadata-only hits that have no chunk info, we need to fetch basic info
    # so the result can still be returned
    meta_only_ids = set(doc_scores.keys()) - set(doc_best_chunk.keys())
    if meta_only_ids:
        stmt = (
            select(Document.id, Document.title, Document.file_type,
                   Document.summary, Document.updated_at)
            .where(Document.id.in_([uuid.UUID(d) for d in meta_only_ids]))
        )
        async with async_session() as s:
            rows = (await s.execute(stmt)).all()
        for row in rows:
            did = str(row.id)
            doc_best_chunk[did] = {
                "chunk_id": None,
                "document_id": did,
                "chunk_index": 0,
                "content": "",
                "document_title": row.title,
                "document_summary": row.summary,
                "file_type": row.file_type,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                "source": "metadata",
            }
            doc_updated_at[did] = row.updated_at.isoformat() if row.updated_at else None
            # Apply freshness for newly discovered docs (scaled by match_ratio)
            if row.updated_at:
                days_old = max(0, (now - row.updated_at).total_seconds() / 86400)
                freshness = 1.0 / (1.0 + days_old / _FRESHNESS_HALF_LIFE_DAYS)
                mc = doc_match_count.get(did, 0)
                mr = min(mc, total_tokens) / total_tokens if total_tokens > 1 else 1.0
                doc_scores[did] += _FRESHNESS_WEIGHT * freshness * mr ** 2

    # DEBUG: Log score breakdown for top results
    import logging
    _log = logging.getLogger(__name__)
    ranked_docs = sorted(doc_scores.keys(), key=lambda d: doc_scores[d], reverse=True)
    for doc_id in ranked_docs[:10]:
        chunk = doc_best_chunk.get(doc_id, {})
        title = chunk.get("document_title", "?")
        mc = doc_match_count.get(doc_id, 0)
        mr = min(mc, total_tokens) / total_tokens if total_tokens > 1 else 1.0
        in_ft = doc_id in doc_ft_rank
        in_vec = doc_id in doc_vec_rank
        meta_hits = [s for s in ("title", "title_full", "filename", "tag", "memo", "summary") if doc_id in meta_results.get(s, [])]
        _log.warning(
            f"SEARCH DEBUG [{doc_scores[doc_id]:.4f}] {title[:40]} | "
            f"mc={mc}/{total_tokens} mr={mr:.2f} ft={in_ft} vec={in_vec} "
            f"meta={meta_hits} dist={doc_distances.get(doc_id, '-')}"
        )

    all_results = []
    for doc_id in ranked_docs:
        chunk = doc_best_chunk.get(doc_id)
        if not chunk:
            continue
        entry = chunk.copy()
        entry["rrf_score"] = doc_scores[doc_id]
        if doc_id in doc_distances:
            entry["distance"] = doc_distances[doc_id]
        entry["source"] = "merged"
        all_results.append(entry)

    total = len(all_results)
    page = all_results[offset: offset + limit]
    return page, total


async def title_search(
    db: AsyncSession, query: str, limit: int = 10,
    require_ai_knowledge: bool = False,
    user: User | None = None,
) -> list[dict]:
    """Search documents by title/filename using ILIKE."""
    words = tokenize_query(query)
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
