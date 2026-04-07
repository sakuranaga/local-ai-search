"""Document version management: snapshot, restore, and cleanup."""

import logging
import os
import shutil
import uuid
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document, DocumentVersion, File

logger = logging.getLogger(__name__)

STORAGE_ROOT = os.environ.get("STORAGE_PATH", "/app/storage")


async def _get_max_version(db: AsyncSession, doc_id: uuid.UUID) -> int:
    result = await db.execute(
        select(func.max(DocumentVersion.version_number)).where(
            DocumentVersion.document_id == doc_id
        )
    )
    return result.scalar() or 0


async def _copy_file_to_version(
    doc_id: uuid.UUID, version_number: int, file_record: File | None,
) -> tuple[str | None, int | None]:
    """Copy the live file to a versioned directory. Returns (source_path, file_size)."""
    if not file_record or not Path(file_record.storage_path).exists():
        return None, None

    version_dir = Path(STORAGE_ROOT) / "versions" / str(doc_id) / str(version_number)
    version_dir.mkdir(parents=True, exist_ok=True)
    dest_path = version_dir / file_record.filename
    shutil.copy2(file_record.storage_path, str(dest_path))
    return str(dest_path), file_record.file_size


async def _save_version(
    db: AsyncSession,
    doc_id: uuid.UUID,
    version_number: int,
    title: str,
    content: str,
    file_type: str,
    source_path: str | None,
    file_size: int | None,
    user_id: uuid.UUID | None,
    change_type: str | None = None,
) -> DocumentVersion:
    version = DocumentVersion(
        document_id=doc_id,
        version_number=version_number,
        title=title,
        content=content,
        file_type=file_type,
        source_path=source_path,
        file_size=file_size,
        change_type=change_type,
        created_by_id=user_id,
    )
    db.add(version)
    await db.flush()
    return version


async def create_initial_version(
    db: AsyncSession,
    doc: Document,
    user_id: uuid.UUID | None,
) -> None:
    """Create version 1 when a document is first uploaded/created."""
    file_result = await db.execute(
        select(File).where(File.document_id == doc.id).limit(1)
    )
    file_record = file_result.scalar_one_or_none()

    source_path, file_size = await _copy_file_to_version(doc.id, 1, file_record)
    await _save_version(
        db, doc.id, 1, doc.title, doc.content or "",
        doc.file_type, source_path, file_size, user_id, "upload",
    )
    doc.current_version = 1
    logger.info("Created initial version 1 for document %s", doc.id)


async def create_versions_on_edit(
    db: AsyncSession,
    doc: Document,
    user_id: uuid.UUID | None,
) -> int:
    """Call BEFORE modifying doc content/file. Saves the old state.

    If no versions exist (legacy doc uploaded before versioning), saves
    the current state as v1 first. Returns the version number to assign
    to the NEW state (caller must also call save_new_version after
    modifying the document).
    """
    max_ver = await _get_max_version(db, doc.id)

    if max_ver == 0:
        # Legacy doc: save current state as v1 before editing
        file_result = await db.execute(
            select(File).where(File.document_id == doc.id).limit(1)
        )
        file_record = file_result.scalar_one_or_none()
        source_path, file_size = await _copy_file_to_version(doc.id, 1, file_record)
        await _save_version(
            db, doc.id, 1, doc.title, doc.content or "",
            doc.file_type, source_path, file_size, user_id, "upload",
        )
        logger.info("Created version 1 (legacy backfill) for document %s", doc.id)
        return 2

    return max_ver + 1


async def save_new_version(
    db: AsyncSession,
    doc: Document,
    version_number: int,
    user_id: uuid.UUID | None,
    change_type: str | None = None,
) -> None:
    """Call AFTER modifying doc content/file. Saves the new state as the given version."""
    file_result = await db.execute(
        select(File).where(File.document_id == doc.id).limit(1)
    )
    file_record = file_result.scalar_one_or_none()

    source_path, file_size = await _copy_file_to_version(doc.id, version_number, file_record)
    await _save_version(
        db, doc.id, version_number, doc.title, doc.content or "",
        doc.file_type, source_path, file_size, user_id, change_type,
    )
    doc.current_version = version_number
    logger.info("Created version %d for document %s", version_number, doc.id)


async def restore_version(
    db: AsyncSession,
    doc: Document,
    version_number: int,
) -> None:
    """Restore a document to a previous version (pointer move, no new version)."""
    result = await db.execute(
        select(DocumentVersion).where(
            DocumentVersion.document_id == doc.id,
            DocumentVersion.version_number == version_number,
        )
    )
    version = result.scalar_one_or_none()
    if version is None:
        raise ValueError(f"Version {version_number} not found for document {doc.id}")

    # Update document content and metadata
    # Only overwrite content if the version actually captured it;
    # versions created before text extraction completed have empty content.
    if version.content:
        doc.content = version.content
    doc.title = version.title
    doc.current_version = version_number

    # If the version has a physical file, restore it
    if version.source_path and Path(version.source_path).exists():
        file_result = await db.execute(
            select(File).where(File.document_id == doc.id).limit(1)
        )
        file_record = file_result.scalar_one_or_none()

        if file_record:
            shutil.copy2(version.source_path, file_record.storage_path)
            if version.file_size is not None:
                file_record.file_size = version.file_size

    # Delete old chunks and trigger reprocessing
    await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))
    doc.processing_status = "pending"
    await db.flush()

    file_result = await db.execute(
        select(File).where(File.document_id == doc.id).limit(1)
    )
    file_record = file_result.scalar_one_or_none()
    storage_path = file_record.storage_path if file_record else ""
    filename = file_record.filename if file_record else doc.title

    from app.services.job_queue import create_job

    await create_job(db, "document_processing", {
        "doc_id": str(doc.id),
        "storage_path": storage_path,
        "file_type": doc.file_type,
        "filename": filename,
    })
    await db.commit()

    logger.info("Restored document %s to version %d", doc.id, version_number)


async def delete_version_files(doc_id: uuid.UUID) -> None:
    """Remove versioned files from disk. DB rows cascade-delete via FK."""
    version_dir = Path(STORAGE_ROOT) / "versions" / str(doc_id)
    if version_dir.exists():
        shutil.rmtree(str(version_dir), ignore_errors=True)
        logger.info("Deleted version files for document %s", doc_id)
