"""WOPI endpoints for Collabora Online integration."""

import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Document, File, User
from app.services.auth import verify_token

router = APIRouter(prefix="/wopi", tags=["wopi"])

STORAGE_PATH = os.environ.get("STORAGE_PATH", "/app/storage")


async def _get_user_by_token(access_token: str, db: AsyncSession) -> User:
    """Validate WOPI access token and return the user."""
    payload = verify_token(access_token, expected_type="access")
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    import uuid
    user_id = uuid.UUID(payload["sub"])
    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def _get_document_and_file(doc_id: str, db: AsyncSession) -> tuple[Document, File]:
    """Load document and its primary file."""
    import uuid as _uuid
    result = await db.execute(
        select(Document).where(Document.id == _uuid.UUID(doc_id), Document.deleted_at.is_(None))
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    file_result = await db.execute(
        select(File).where(File.document_id == doc.id).order_by(File.created_at.desc()).limit(1)
    )
    file = file_result.scalar_one_or_none()
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    return doc, file


@router.get("/files/{doc_id}")
async def check_file_info(
    doc_id: str,
    access_token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """WOPI CheckFileInfo — return file metadata."""
    user = await _get_user_by_token(access_token, db)
    doc, file = await _get_document_and_file(doc_id, db)

    return {
        "BaseFileName": doc.title or "untitled",
        "Size": file.file_size or 0,
        "OwnerId": str(doc.owner_id),
        "UserId": str(user.id),
        "UserFriendlyName": user.display_name or user.username,
        "UserCanWrite": True,
        "PostMessageOrigin": "*",
    }


@router.get("/files/{doc_id}/contents")
async def get_file(
    doc_id: str,
    access_token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """WOPI GetFile — return file contents."""
    await _get_user_by_token(access_token, db)
    doc, file = await _get_document_and_file(doc_id, db)

    file_path = os.path.join(STORAGE_PATH, file.storage_path)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not on disk")

    with open(file_path, "rb") as f:
        content = f.read()

    return Response(content=content, media_type="application/octet-stream")


@router.post("/files/{doc_id}/contents")
async def put_file(
    doc_id: str,
    access_token: str = Query(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """WOPI PutFile — save edited file contents."""
    await _get_user_by_token(access_token, db)
    doc, file = await _get_document_and_file(doc_id, db)

    file_path = os.path.join(STORAGE_PATH, file.storage_path)
    content = await request.body()

    with open(file_path, "wb") as f:
        f.write(content)

    # Update file size
    file.file_size = len(content)
    await db.commit()

    return Response(status_code=200)
