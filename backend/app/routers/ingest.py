import asyncio
import os
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import async_session
from app.deps import get_current_user, require_permission
from app.models import Chunk, Document, File, User
from app.services.embedding import get_embeddings
from app.services.parser import chunk_text, parse_file

router = APIRouter(prefix="/ingest", tags=["ingest"])

# In-memory job status tracking
_ingest_jobs: dict[str, dict] = {}

SUPPORTED_EXTENSIONS = {".md", ".txt", ".pdf", ".docx", ".doc", ".markdown"}


class DirectoryIngestRequest(BaseModel):
    path: str
    recursive: bool = True


class WikiSyncRequest(BaseModel):
    path: str  # Path to wiki_sync output directory


class IngestJobResponse(BaseModel):
    job_id: str
    status: str
    total_files: int
    processed_files: int
    failed_files: int
    errors: list[str]


def _get_file_type(filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    type_map = {
        "md": "md",
        "markdown": "md",
        "txt": "md",
        "pdf": "pdf",
        "docx": "docx",
        "doc": "docx",
    }
    return type_map.get(ext, "md")


def _collect_files(directory: str, recursive: bool = True) -> list[Path]:
    """Collect all supported files from a directory."""
    base = Path(directory)
    if not base.is_dir():
        return []

    files: list[Path] = []
    if recursive:
        for ext in SUPPORTED_EXTENSIONS:
            files.extend(base.rglob(f"*{ext}"))
    else:
        for ext in SUPPORTED_EXTENSIONS:
            files.extend(base.glob(f"*{ext}"))

    return sorted(files)


async def _ingest_file(
    file_path: Path, owner_id: uuid.UUID | None, db: AsyncSession
) -> None:
    """Ingest a single file: parse, chunk, embed, and store."""
    file_type = _get_file_type(file_path.name)
    text_content = await parse_file(str(file_path), file_type)

    if not text_content.strip():
        return

    doc = Document(
        title=file_path.name,
        source_path=str(file_path),
        file_type=file_type,
        content=text_content,
        owner_id=owner_id,
        is_public=True,
    )
    db.add(doc)
    await db.flush()

    file_record = File(
        document_id=doc.id,
        filename=file_path.name,
        storage_path=str(file_path),
        file_size=file_path.stat().st_size,
        mime_type=None,
    )
    db.add(file_record)

    chunks_text = chunk_text(text_content)
    if not chunks_text:
        return

    try:
        embeddings = await get_embeddings(chunks_text)
    except Exception:
        embeddings = [None] * len(chunks_text)

    for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
        chunk = Chunk(
            document_id=doc.id,
            chunk_index=i,
            content=chunk_content,
            embedding=embedding,
        )
        db.add(chunk)


async def _run_ingest_job(
    job_id: str, files: list[Path], owner_id: uuid.UUID | None
) -> None:
    """Background task that ingests a list of files."""
    job = _ingest_jobs[job_id]
    job["status"] = "running"

    for file_path in files:
        try:
            async with async_session() as db:
                try:
                    await _ingest_file(file_path, owner_id, db)
                    await db.commit()
                    job["processed_files"] += 1
                except Exception as e:
                    await db.rollback()
                    job["failed_files"] += 1
                    job["errors"].append(f"{file_path.name}: {str(e)}")
        except Exception as e:
            job["failed_files"] += 1
            job["errors"].append(f"{file_path.name}: {str(e)}")

    job["status"] = "completed"


@router.post("/directory", response_model=IngestJobResponse)
async def ingest_directory(
    body: DirectoryIngestRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """Start a bulk ingest job from a directory path."""
    directory = Path(body.path)
    if not directory.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {body.path}")

    files = _collect_files(body.path, recursive=body.recursive)
    if not files:
        raise HTTPException(
            status_code=400,
            detail=f"No supported files found in {body.path}",
        )

    job_id = str(uuid.uuid4())
    _ingest_jobs[job_id] = {
        "status": "pending",
        "total_files": len(files),
        "processed_files": 0,
        "failed_files": 0,
        "errors": [],
    }

    background_tasks.add_task(_run_ingest_job, job_id, files, current_user.id)

    return IngestJobResponse(
        job_id=job_id,
        status="pending",
        total_files=len(files),
        processed_files=0,
        failed_files=0,
        errors=[],
    )


@router.post("/wiki-sync", response_model=IngestJobResponse)
async def ingest_wiki_sync(
    body: WikiSyncRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """Ingest documents from a wiki_sync converted output directory.

    wiki_sync typically outputs markdown files from Confluence/wiki exports.
    This endpoint treats the directory as a collection of markdown files.
    """
    directory = Path(body.path)
    if not directory.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {body.path}")

    # wiki_sync outputs are typically .md files
    files = _collect_files(body.path, recursive=True)
    if not files:
        raise HTTPException(
            status_code=400,
            detail=f"No supported files found in {body.path}",
        )

    job_id = str(uuid.uuid4())
    _ingest_jobs[job_id] = {
        "status": "pending",
        "total_files": len(files),
        "processed_files": 0,
        "failed_files": 0,
        "errors": [],
    }

    background_tasks.add_task(_run_ingest_job, job_id, files, current_user.id)

    return IngestJobResponse(
        job_id=job_id,
        status="pending",
        total_files=len(files),
        processed_files=0,
        failed_files=0,
        errors=[],
    )


@router.get("/status", response_model=list[IngestJobResponse])
async def list_ingest_jobs(
    current_user: User = Depends(get_current_user),
):
    """List all ingest job statuses."""
    return [
        IngestJobResponse(
            job_id=job_id,
            status=job["status"],
            total_files=job["total_files"],
            processed_files=job["processed_files"],
            failed_files=job["failed_files"],
            errors=job["errors"],
        )
        for job_id, job in _ingest_jobs.items()
    ]


@router.get("/status/{job_id}", response_model=IngestJobResponse)
async def get_ingest_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get the status of a specific ingest job."""
    job = _ingest_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    return IngestJobResponse(
        job_id=job_id,
        status=job["status"],
        total_files=job["total_files"],
        processed_files=job["processed_files"],
        failed_files=job["failed_files"],
        errors=job["errors"],
    )
