"""Document processing helpers: file type detection, list item building,
tag loading, and background processing pipeline."""

import logging
import uuid
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document, DocumentTag, Tag
from app.schemas.documents import DocumentListItem, TagInfo
from app.services.embedding import get_embedding, get_embeddings
from app.services.llm import generate_summary
from app.services.parser import chunk_text, parse_file
from app.services.permissions import format_permission_string

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# File type detection
# ---------------------------------------------------------------------------

_TYPE_MAP = {
    "md": "md",
    "markdown": "md",
    "txt": "txt",
    "pdf": "pdf",
    "docx": "docx",
    "doc": "doc",
    "xlsx": "xlsx",
    "xls": "xls",
    "csv": "csv",
    "tsv": "csv",
    "html": "html",
    "htm": "html",
    "pptx": "pptx",
    "ppt": "ppt",
    "png": "png",
    "jpg": "jpg",
    "jpeg": "jpg",
    "gif": "gif",
    "bmp": "bmp",
    "tiff": "tiff",
    "tif": "tiff",
    "webp": "webp",
}

# Tier 1: file types that support text extraction → chunk → embed → summarize
EXTRACTABLE_TYPES = {
    "md", "txt", "pdf", "docx", "doc", "xlsx", "xls", "csv", "html", "pptx", "ppt", "rtf",
    "png", "jpg", "gif", "bmp", "tiff", "webp",
}


def get_file_type(filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    if not ext:
        return "other"
    return _TYPE_MAP.get(ext, ext)


# ---------------------------------------------------------------------------
# Build DocumentListItem from query row
# ---------------------------------------------------------------------------

def make_doc_list_item(
    row, tags: list[TagInfo] | None = None, group_name: str | None = None,
) -> DocumentListItem:
    """Build a DocumentListItem from a query row with Unix permission fields."""
    g_read = getattr(row, "group_read", False) or False
    g_write = getattr(row, "group_write", False) or False
    o_read = getattr(row, "others_read", True)
    o_write = getattr(row, "others_write", False) or False
    o_read_val = o_read if o_read is not None else True
    return DocumentListItem.model_construct(
        id=str(row.id),
        title=row.title,
        summary=getattr(row, "summary", None),
        source_path=getattr(row, "source_path", None),
        file_type=row.file_type,
        owner_id=str(row.owner_id) if getattr(row, "owner_id", None) else None,
        owner_name=getattr(row, "owner_name", None),
        group_id=str(row.group_id) if getattr(row, "group_id", None) else None,
        group_name=group_name or getattr(row, "group_name", None),
        group_read=g_read,
        group_write=g_write,
        others_read=o_read_val,
        others_write=o_write,
        permissions=format_permission_string(g_read, g_write, o_read_val, o_write),
        searchable=getattr(row, "searchable", True),
        ai_knowledge=getattr(row, "ai_knowledge", True),
        file_size=getattr(row, "file_size", None),
        chunk_count=getattr(row, "chunk_count", 0),
        share_prohibited=getattr(row, "share_prohibited", False),
        download_prohibited=getattr(row, "download_prohibited", False),
        scan_status=getattr(row, "scan_status", "pending"),
        share_count=getattr(row, "share_count", 0),
        is_note=getattr(row, "is_note", False),
        memo=getattr(row, "memo", None),
        folder_id=str(row.folder_id) if getattr(row, "folder_id", None) else None,
        folder_name=getattr(row, "folder_name", None),
        tags=tags or [],
        created_by_name=getattr(row, "created_by_name", None),
        updated_by_name=getattr(row, "updated_by_name", None),
        created_at=row.created_at,
        updated_at=row.updated_at,
        last_accessed_at=getattr(row, "last_accessed_at", None),
    )


# ---------------------------------------------------------------------------
# Batch-load tags for documents
# ---------------------------------------------------------------------------

async def load_tags_for_docs(db: AsyncSession, doc_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[TagInfo]]:
    """Load tags for a batch of documents. Returns {doc_id: [TagInfo, ...]}."""
    if not doc_ids:
        return {}
    result = await db.execute(
        select(DocumentTag.document_id, Tag.id, Tag.name, Tag.color)
        .join(Tag, DocumentTag.tag_id == Tag.id)
        .where(DocumentTag.document_id.in_(doc_ids))
        .order_by(Tag.name)
    )
    tags_map: dict[uuid.UUID, list[TagInfo]] = {}
    for row in result.all():
        tags_map.setdefault(row[0], []).append(
            TagInfo(id=row[1], name=row[2], color=row[3])
        )
    return tags_map


# ---------------------------------------------------------------------------
# Text sanitization
# ---------------------------------------------------------------------------

def _sanitize_text(text: str | None) -> str:
    """Remove NULL bytes and non-printable control chars (keep newline/tab)."""
    if not text:
        return text or ""
    text = text.replace("\x00", "")
    return "".join(
        ch for ch in text
        if ch in ("\n", "\r", "\t") or (ord(ch) >= 32)
    )


# ---------------------------------------------------------------------------
# Reindex: parse → chunk → embed → save (single document)
# ---------------------------------------------------------------------------

async def reindex_document_content(
    db: AsyncSession,
    doc: "Document",
    *,
    updated_by_id: uuid.UUID | None = None,
) -> tuple[str, list[str]]:
    """Re-parse, re-chunk, and re-embed a single document.

    Returns (text_content, chunks_text) for callers that need them.
    Caller is responsible for commit/flush.
    """
    from app.services.embedding import get_embeddings

    # Parse
    text_content = doc.content or ""
    if doc.source_path and Path(doc.source_path).exists():
        try:
            text_content = await parse_file(doc.source_path, doc.file_type)
            text_content = _sanitize_text(text_content)
        except Exception:
            pass  # fall back to stored content

    doc.content = text_content

    # Delete old chunks
    await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))

    # Chunk
    chunks_text = chunk_text(text_content)

    # Embed
    try:
        embeddings = await get_embeddings(chunks_text)
    except Exception:
        embeddings = [None] * len(chunks_text)

    # Save new chunks
    for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
        db.add(Chunk(
            document_id=doc.id,
            chunk_index=i,
            content=_sanitize_text(chunk_content),
            embedding=embedding,
        ))

    if updated_by_id is not None:
        doc.updated_by_id = updated_by_id
        doc.updated_at = func.now()
    else:
        # 再構築時は updated_at を変更しない
        # doc.content 代入で dirty になるため、明示的に元の値を保持
        from sqlalchemy import inspect
        history = inspect(doc).attrs.updated_at.history
        if history.unchanged:
            doc.updated_at = history.unchanged[0]

    return text_content, chunks_text


# ---------------------------------------------------------------------------
# Background processing (called by queue-worker)
# ---------------------------------------------------------------------------


async def process_document_job(
    job_id: uuid.UUID,
    doc_id: uuid.UUID,
    storage_path: str,
    file_type: str,
    filename: str,
    session_factory,
):
    """Process a document: parse → chunk → embed → summarize → preview.

    Called by the queue-worker process. Updates both Document.processing_status
    and Job.progress. Raises on failure so the worker can handle retries.
    """
    from app.services.job_queue import update_progress

    async def _set_status_and_progress(status: str):
        async with session_factory() as db:
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc:
                doc.processing_status = status
                await db.commit()
        async with session_factory() as db:
            await update_progress(db, job_id, status)

    # Tier 2/3: no text extraction — mark done immediately
    if file_type not in EXTRACTABLE_TYPES:
        async with session_factory() as db:
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc:
                doc.processing_status = "done"
                await db.commit()
        logger.info("Non-extractable file, skipped processing: %s (%s)", filename, file_type)
        return

    # Phase 1: Parse / OCR
    await _set_status_and_progress("parsing")
    text_content = await parse_file(storage_path, file_type)
    text_content = _sanitize_text(text_content)

    # Phase 2: Chunking
    await _set_status_and_progress("chunking")
    chunks_text = chunk_text(text_content)

    # Phase 3: Embedding
    await _set_status_and_progress("embedding")
    try:
        embeddings = await get_embeddings(chunks_text)
    except Exception:
        embeddings = [None] * len(chunks_text)

    # Title embedding
    try:
        title_text = filename
        async with session_factory() as db:
            result = await db.execute(
                select(Document.title, Document.source_path).where(Document.id == doc_id)
            )
            row = result.one_or_none()
            if row:
                parts = [row.title]
                if row.source_path and row.source_path != row.title:
                    parts.append(row.source_path)
                title_text = " | ".join(parts)
        title_emb = await get_embedding(title_text)
    except Exception:
        title_emb = None

    # Save content + chunks
    async with session_factory() as db:
        result = await db.execute(select(Document).where(Document.id == doc_id))
        doc = result.scalar_one_or_none()
        if not doc:
            return
        doc.content = text_content
        doc.title_embedding = title_emb
        doc.processing_status = "summarizing"
        await db.execute(delete(Chunk).where(Chunk.document_id == doc_id))
        for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
            db.add(Chunk(
                document_id=doc_id,
                chunk_index=i,
                content=chunk_content,
                embedding=embedding,
            ))
        # Backfill empty version content now that text extraction is done
        from app.models import DocumentVersion
        await db.execute(
            DocumentVersion.__table__.update()
            .where(
                DocumentVersion.document_id == doc_id,
                DocumentVersion.content == "",
            )
            .values(content=text_content)
        )
        await db.commit()

    # Phase 4: Summary
    await _set_status_and_progress("summarizing")
    try:
        summary = await generate_summary(text_content, filename)
    except Exception:
        summary = None

    async with session_factory() as db:
        result = await db.execute(select(Document).where(Document.id == doc_id))
        doc = result.scalar_one_or_none()
        if doc:
            if summary:
                doc.summary = summary
            doc.processing_status = "done"
            await db.commit()

    # Phase 5: Preview image generation
    from app.services.preview_generator import PREVIEW_ELIGIBLE, generate_preview_images
    if file_type in PREVIEW_ELIGIBLE:
        try:
            page_count = await generate_preview_images(str(doc_id), storage_path, file_type)
            logger.info("Generated %d preview images for %s", page_count, filename)
        except Exception as e:
            logger.warning("Preview generation failed for %s: %s", filename, e)

    logger.info("Processing complete: %s (%s)", filename, doc_id)
