import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.deps import get_current_user
from app.models import Chunk, Document, File, User
from app.services.embedding import get_embeddings
from app.services.parser import chunk_text, parse_file

router = APIRouter(prefix="/documents", tags=["documents"])


class DocumentResponse(BaseModel):
    id: str
    title: str
    source_path: str | None
    file_type: str
    is_public: bool
    chunk_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentDetail(DocumentResponse):
    content: str
    files: list[dict]
    chunks: list[dict]


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


@router.post("/upload", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a file, parse it, chunk the content, and create embeddings."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    file_type = _get_file_type(file.filename)

    # Save uploaded file to storage
    storage_dir = Path(settings.STORAGE_PATH) / "uploads" / str(current_user.id)
    storage_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4()
    stored_filename = f"{file_id}_{file.filename}"
    storage_path = storage_dir / stored_filename

    content_bytes = await file.read()
    with open(storage_path, "wb") as f:
        f.write(content_bytes)

    file_size = len(content_bytes)

    # Parse the file to extract text
    try:
        text_content = await parse_file(str(storage_path), file_type)
    except Exception as e:
        # Clean up on parse failure
        storage_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400, detail=f"Failed to parse file: {e}"
        )

    # Create the document record
    doc = Document(
        title=file.filename,
        source_path=str(storage_path),
        file_type=file_type,
        content=text_content,
        owner_id=current_user.id,
        is_public=True,
    )
    db.add(doc)
    await db.flush()

    # Create file record
    file_record = File(
        document_id=doc.id,
        filename=file.filename,
        storage_path=str(storage_path),
        file_size=file_size,
        mime_type=file.content_type,
    )
    db.add(file_record)

    # Chunk the text
    chunks_text = chunk_text(text_content)

    # Get embeddings for all chunks
    try:
        embeddings = await get_embeddings(chunks_text)
    except Exception:
        # If embedding service is unavailable, store chunks without embeddings
        embeddings = [None] * len(chunks_text)

    # Create chunk records
    for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
        chunk = Chunk(
            document_id=doc.id,
            chunk_index=i,
            content=chunk_content,
            embedding=embedding,
        )
        db.add(chunk)

    await db.flush()
    await db.refresh(doc)

    return DocumentResponse(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        is_public=doc.is_public,
        chunk_count=len(chunks_text),
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


@router.get("/", response_model=list[DocumentResponse])
async def list_documents(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all documents accessible to the current user."""
    stmt = (
        select(Document)
        .where(
            (Document.is_public.is_(True)) | (Document.owner_id == current_user.id)
        )
        .order_by(Document.created_at.desc())
    )
    result = await db.execute(stmt)
    documents = result.scalars().all()

    response = []
    for doc in documents:
        # Count chunks
        chunk_result = await db.execute(
            select(Chunk.id).where(Chunk.document_id == doc.id)
        )
        chunk_count = len(chunk_result.all())

        response.append(
            DocumentResponse(
                id=str(doc.id),
                title=doc.title,
                source_path=doc.source_path,
                file_type=doc.file_type,
                is_public=doc.is_public,
                chunk_count=chunk_count,
                created_at=doc.created_at,
                updated_at=doc.updated_at,
            )
        )

    return response


@router.get("/{document_id}", response_model=DocumentDetail)
async def get_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get full document details including chunks and files."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not doc.is_public and doc.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    # Get chunks
    chunks_result = await db.execute(
        select(Chunk)
        .where(Chunk.document_id == doc.id)
        .order_by(Chunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()

    # Get files
    files_result = await db.execute(
        select(File).where(File.document_id == doc.id)
    )
    files = files_result.scalars().all()

    return DocumentDetail(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        is_public=doc.is_public,
        content=doc.content,
        chunk_count=len(chunks),
        created_at=doc.created_at,
        updated_at=doc.updated_at,
        chunks=[
            {
                "id": str(c.id),
                "chunk_index": c.chunk_index,
                "content": c.content,
                "has_embedding": c.embedding is not None,
            }
            for c in chunks
        ],
        files=[
            {
                "id": str(f.id),
                "filename": f.filename,
                "file_size": f.file_size,
                "mime_type": f.mime_type,
            }
            for f in files
        ],
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a document and its associated chunks and files."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if doc.owner_id != current_user.id:
        # Check if user has admin permission
        user_permissions: set[str] = set()
        for ur in current_user.roles:
            if ur.role.permissions:
                user_permissions.update(
                    p.strip() for p in ur.role.permissions.split(",") if p.strip()
                )
        if "admin" not in user_permissions:
            raise HTTPException(status_code=403, detail="Access denied")

    # Delete associated files from disk
    files_result = await db.execute(
        select(File).where(File.document_id == doc.id)
    )
    for f in files_result.scalars().all():
        try:
            Path(f.storage_path).unlink(missing_ok=True)
        except OSError:
            pass

    await db.delete(doc)
