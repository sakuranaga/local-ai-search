"""Document processing helpers: file type detection, list item building,
tag loading, and background processing pipeline."""

import asyncio
import logging
import uuid
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import async_session
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
    "doc": "docx",
    "xlsx": "xlsx",
    "xls": "xlsx",
    "csv": "csv",
    "tsv": "csv",
    "html": "html",
    "htm": "html",
    "pptx": "pptx",
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
    "md", "txt", "pdf", "docx", "xlsx", "csv", "html", "pptx", "rtf",
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
    return DocumentListItem(
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
        others_read=o_read if o_read is not None else True,
        others_write=o_write,
        permissions=format_permission_string(g_read, g_write, o_read if o_read is not None else True, o_write),
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
# Background processing pipeline
# ---------------------------------------------------------------------------

# Limit concurrent GPU-heavy tasks (embedding + summarization)
_gpu_semaphore = asyncio.Semaphore(2)


async def _set_status(doc_id: uuid.UUID, status: str):
    """Quick DB session just to update processing_status."""
    async with async_session() as db:
        result = await db.execute(select(Document).where(Document.id == doc_id))
        doc = result.scalar_one_or_none()
        if doc:
            doc.processing_status = status
            await db.commit()


async def process_document_background(doc_id: uuid.UUID, storage_path: str, file_type: str, filename: str):
    """Background task: parse → chunk → embed → summarize.

    Each phase opens/closes its own DB session so connections are not held
    during long-running GPU operations (embedding, summarization).
    Non-extractable file types (Tier 2/3) skip the pipeline entirely.
    """
    try:
        # Tier 2/3: no text extraction — mark done immediately
        if file_type not in EXTRACTABLE_TYPES:
            await _set_status(doc_id, "done")
            logger.info(f"Non-extractable file, skipped processing: {filename} ({file_type})")
            return

        # Phase 1: Parse / OCR (no DB session held during I/O)
        await _set_status(doc_id, "parsing")
        try:
            text_content = await parse_file(storage_path, file_type)
        except Exception as e:
            logger.error(f"Parse failed for {filename}: {e}")
            await _set_status(doc_id, "error")
            return

        # Save parsed content + chunking
        await _set_status(doc_id, "chunking")
        chunks_text = chunk_text(text_content)

        # Phase 2: Embedding (GPU - done outside DB session)
        await _set_status(doc_id, "embedding")
        async with _gpu_semaphore:
            try:
                embeddings = await get_embeddings(chunks_text)
            except Exception:
                embeddings = [None] * len(chunks_text)
            # Title embedding (title + filename for semantic search)
            try:
                title_text = filename
                async with async_session() as db:
                    result = await db.execute(select(Document.title, Document.source_path).where(Document.id == doc_id))
                    row = result.one_or_none()
                    if row:
                        parts = [row.title]
                        if row.source_path and row.source_path != row.title:
                            parts.append(row.source_path)
                        title_text = " | ".join(parts)
                title_emb = await get_embedding(title_text)
            except Exception:
                title_emb = None

        # Phase 3: Save content + chunks to DB (short session)
        async with async_session() as db:
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
            await db.commit()

        # Phase 4: Summary (GPU - done outside DB session)
        async with _gpu_semaphore:
            try:
                summary = await generate_summary(text_content, filename)
            except Exception:
                summary = None

        # Save summary (short session)
        async with async_session() as db:
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc:
                if summary:
                    doc.summary = summary
                doc.processing_status = "done"
                await db.commit()

        # Phase 5: Preview image generation (LibreOffice, non-GPU)
        from app.services.preview_generator import PREVIEW_ELIGIBLE, generate_preview_images
        if file_type in PREVIEW_ELIGIBLE:
            try:
                page_count = await generate_preview_images(str(doc_id), storage_path, file_type)
                logger.info(f"Generated {page_count} preview images for {filename}")
            except Exception as e:
                logger.warning(f"Preview generation failed for {filename}: {e}")

        logger.info(f"Background processing complete: {filename} ({doc_id})")

    except Exception as e:
        logger.error(f"Background processing error for {doc_id}: {e}")
        try:
            await _set_status(doc_id, "error")
        except Exception:
            pass
