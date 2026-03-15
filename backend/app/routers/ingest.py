"""External ingest API — API key authenticated file upload and management.

Endpoints:
  POST   /api/ingest/upload     Upload a file (single)
  POST   /api/ingest/upload-batch  Upload multiple files
  GET    /api/ingest/status/{id} Check processing status
  DELETE /api/ingest/{id}        Delete a document
  GET    /api/ingest/list        List documents accessible by this API key
"""

import base64
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import async_session, get_db
from app.deps import get_api_key, get_current_user
from app.models import ApiKey, Chunk, Document, File, Folder, User
from app.services.auth import verify_token
from app.services.document_processing import get_file_type, process_document_background

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_api_key(user: User) -> ApiKey:
    """Ensure the request is authenticated via API key."""
    api_key = get_api_key(user)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint requires API key authentication",
        )
    return api_key


def _check_permission(api_key: ApiKey, permission: str) -> None:
    perms = {p.strip() for p in api_key.permissions.split(",") if p.strip()}
    if permission not in perms:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"API key lacks '{permission}' permission",
        )


def _resolve_folder_id(api_key: ApiKey, requested_folder_id: uuid.UUID | None) -> uuid.UUID | None:
    """Resolve the target folder, enforcing API key folder restriction."""
    if api_key.folder_id:
        # API key is restricted to a specific folder
        if requested_folder_id and requested_folder_id != api_key.folder_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="API key is restricted to a specific folder",
            )
        return api_key.folder_id
    return requested_folder_id


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class IngestResponse(BaseModel):
    id: str
    title: str
    file_type: str
    processing_status: str
    created: bool  # True = new doc, False = overwritten
    created_at: datetime


class IngestStatusResponse(BaseModel):
    id: str
    title: str
    processing_status: str
    chunk_count: int


class IngestListItem(BaseModel):
    id: str
    title: str
    file_type: str
    processing_status: str
    updated_at: datetime


class IngestBatchResponse(BaseModel):
    uploaded: list[IngestResponse]
    errors: list[dict]


# ---------------------------------------------------------------------------
# Core upload logic
# ---------------------------------------------------------------------------

async def _ingest_single_file(
    file: UploadFile,
    folder_id: uuid.UUID | None,
    api_key: ApiKey,
    user: User,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
) -> IngestResponse:
    """Upload and register a single file."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    file_type = get_file_type(file.filename)

    # Save to storage
    storage_dir = Path(settings.STORAGE_PATH) / "uploads" / str(user.id)
    storage_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4()
    suffix = Path(file.filename).suffix
    max_name_bytes = 255 - 37 - len(suffix.encode("utf-8"))
    base_name = Path(file.filename).stem
    truncated = base_name.encode("utf-8")[:max_name_bytes].decode("utf-8", errors="ignore")
    stored_filename = f"{file_id}_{truncated}{suffix}"
    storage_path = storage_dir / stored_filename

    content_bytes = await file.read()
    with open(storage_path, "wb") as f:
        f.write(content_bytes)

    file_size = len(content_bytes)

    # Check for existing document with the same title in the target folder
    existing_query = select(Document).where(
        Document.title == file.filename,
        Document.deleted_at.is_(None),
    )
    if folder_id:
        existing_query = existing_query.where(Document.folder_id == folder_id)

    existing_result = await db.execute(existing_query)
    existing_doc = existing_result.scalars().first()

    created = True

    if existing_doc:
        if not api_key.allow_overwrite:
            # Clean up saved file
            storage_path.unlink(missing_ok=True)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Document '{file.filename}' already exists and overwrite is not allowed",
            )

        # Overwrite existing document
        doc = existing_doc
        created = False

        # Remove old files from disk and DB
        old_files = await db.execute(select(File).where(File.document_id == doc.id))
        for old_f in old_files.scalars().all():
            try:
                Path(old_f.storage_path).unlink(missing_ok=True)
            except OSError:
                pass
            await db.delete(old_f)

        doc.source_path = str(storage_path)
        doc.file_type = file_type
        doc.content = ""
        doc.processing_status = "pending"
        doc.updated_by_id = user.id
        doc.updated_at = func.now()
        if folder_id is not None:
            doc.folder_id = folder_id
    else:
        # Copy permissions from folder
        doc_group_id = None
        doc_group_read = False
        doc_group_write = False
        doc_others_read = True
        doc_others_write = False
        if folder_id:
            folder_obj = await db.get(Folder, folder_id)
            if folder_obj:
                doc_group_id = folder_obj.group_id
                doc_group_read = folder_obj.group_read
                doc_group_write = folder_obj.group_write
                doc_others_read = folder_obj.others_read
                doc_others_write = folder_obj.others_write

        doc = Document(
            title=file.filename,
            source_path=str(storage_path),
            file_type=file_type,
            content="",
            owner_id=user.id,
            group_id=doc_group_id,
            group_read=doc_group_read,
            group_write=doc_group_write,
            others_read=doc_others_read,
            others_write=doc_others_write,
            created_by_id=user.id,
            updated_by_id=user.id,
            processing_status="pending",
            folder_id=folder_id,
        )
        db.add(doc)

    await db.flush()

    # Create file record
    db.add(File(
        document_id=doc.id,
        filename=file.filename,
        storage_path=str(storage_path),
        file_size=file_size,
        mime_type=file.content_type,
    ))

    await db.commit()
    await db.refresh(doc)

    # Background processing
    background_tasks.add_task(
        process_document_background, doc.id, str(storage_path), file_type, file.filename
    )

    return IngestResponse(
        id=str(doc.id),
        title=doc.title,
        file_type=doc.file_type,
        processing_status=doc.processing_status,
        created=created,
        created_at=doc.created_at,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/upload", response_model=IngestResponse, status_code=status.HTTP_201_CREATED)
async def ingest_upload(
    file: UploadFile,
    background_tasks: BackgroundTasks,
    folder_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a single file via API key."""
    api_key = _require_api_key(current_user)
    _check_permission(api_key, "upload")
    resolved_folder = _resolve_folder_id(api_key, folder_id)
    return await _ingest_single_file(
        file, resolved_folder, api_key, current_user, db, background_tasks,
    )


@router.post("/upload-batch", response_model=IngestBatchResponse, status_code=status.HTTP_201_CREATED)
async def ingest_upload_batch(
    files: list[UploadFile],
    background_tasks: BackgroundTasks,
    folder_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload multiple files via API key."""
    api_key = _require_api_key(current_user)
    _check_permission(api_key, "upload")
    resolved_folder = _resolve_folder_id(api_key, folder_id)

    uploaded = []
    errors = []

    for file in files:
        try:
            result = await _ingest_single_file(
                file, resolved_folder, api_key, current_user, db, background_tasks,
            )
            uploaded.append(result)
        except HTTPException as e:
            errors.append({"filename": file.filename or "unknown", "detail": e.detail})
        except Exception as e:
            errors.append({"filename": file.filename or "unknown", "detail": str(e)})

    return IngestBatchResponse(uploaded=uploaded, errors=errors)


@router.get("/status/{document_id}", response_model=IngestStatusResponse)
async def ingest_status(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check document processing status."""
    _require_api_key(current_user)

    result = await db.execute(
        select(
            Document.id,
            Document.title,
            Document.processing_status,
            func.count(Chunk.id).label("chunk_count"),
        )
        .outerjoin(Chunk, Chunk.document_id == Document.id)
        .where(Document.id == document_id, Document.deleted_at.is_(None))
        .group_by(Document.id)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    return IngestStatusResponse(
        id=str(row.id),
        title=row.title,
        processing_status=row.processing_status,
        chunk_count=row.chunk_count,
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def ingest_delete(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete a document via API key."""
    api_key = _require_api_key(current_user)
    _check_permission(api_key, "delete")

    result = await db.execute(
        select(Document).where(Document.id == document_id, Document.deleted_at.is_(None))
    )
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # If API key is folder-restricted, only allow deleting from that folder
    if api_key.folder_id and doc.folder_id != api_key.folder_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key cannot delete documents outside its assigned folder",
        )

    from datetime import timezone
    doc.deleted_at = datetime.now(timezone.utc)
    await db.commit()


@router.get("/list", response_model=list[IngestListItem])
async def ingest_list(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List documents accessible by this API key."""
    api_key = _require_api_key(current_user)

    query = select(Document).where(Document.deleted_at.is_(None))

    # Restrict to API key's folder if set
    if api_key.folder_id:
        query = query.where(Document.folder_id == api_key.folder_id)

    query = query.order_by(Document.updated_at.desc())
    query = query.offset((page - 1) * per_page).limit(per_page)

    result = await db.execute(query)
    docs = result.scalars().all()

    return [
        IngestListItem(
            id=str(d.id),
            title=d.title,
            file_type=d.file_type,
            processing_status=d.processing_status,
            updated_at=d.updated_at,
        )
        for d in docs
    ]


# ---------------------------------------------------------------------------
# tus upload hooks (called by tusd)
# ---------------------------------------------------------------------------


def _decode_tus_metadata(metadata: dict) -> dict[str, str]:
    """Decode base64-encoded tus metadata values."""
    decoded = {}
    for key, value in metadata.items():
        try:
            decoded[key] = base64.b64decode(value).decode("utf-8") if value else ""
        except Exception:
            decoded[key] = value or ""
    return decoded


async def _authenticate_tus_upload(
    metadata: dict[str, str], db: AsyncSession,
) -> tuple[User | None, ApiKey | None]:
    """Authenticate tus upload via JWT token or API key in metadata."""
    token = metadata.get("token", "")
    api_key_str = metadata.get("api_key", "")

    if token:
        payload = verify_token(token, expected_type="access")
        if not payload:
            return None, None
        try:
            user_id = uuid.UUID(payload["sub"])
        except (KeyError, ValueError):
            return None, None
        result = await db.execute(
            select(User).where(User.id == user_id, User.is_active.is_(True))
        )
        user = result.scalar_one_or_none()
        return user, None

    if api_key_str:
        key_hash = hashlib.sha256(api_key_str.encode()).hexdigest()
        result = await db.execute(
            select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.is_active.is_(True))
        )
        api_key = result.scalar_one_or_none()
        if api_key is None:
            return None, None
        if api_key.expires_at and api_key.expires_at < datetime.now(timezone.utc):
            return None, None
        # Check upload permission
        perms = {p.strip() for p in api_key.permissions.split(",") if p.strip()}
        if "upload" not in perms:
            return None, None
        # Load owner
        user_result = await db.execute(
            select(User).where(User.id == api_key.owner_id, User.is_active.is_(True))
        )
        user = user_result.scalar_one_or_none()
        return user, api_key

    return None, None


@router.post("/tus-hook")
async def tus_hook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Handle tusd webhook events (pre-create, post-finish)."""
    body = await request.json()
    event_type = body.get("Type", "")
    upload = body.get("Event", {}).get("Upload", {})
    raw_metadata = upload.get("MetaData", {})
    metadata = _decode_tus_metadata(raw_metadata)

    if event_type == "pre-create":
        # Authenticate and validate before upload starts
        async with async_session() as db:
            user, api_key = await _authenticate_tus_upload(metadata, db)
            if user is None:
                return JSONResponse(
                    status_code=401,
                    content={"HTTPResponse": {"StatusCode": 401, "Body": "Authentication required"}},
                )

            # Check API key folder restriction
            if api_key and api_key.folder_id:
                requested_folder = metadata.get("folder_id", "")
                if requested_folder and requested_folder != str(api_key.folder_id):
                    return JSONResponse(
                        status_code=403,
                        content={"HTTPResponse": {"StatusCode": 403, "Body": "API key restricted to specific folder"}},
                    )

        return JSONResponse(content={})

    if event_type == "post-finish":
        # File upload complete — create Document and start processing
        storage_info = upload.get("Storage", {})
        raw_path = storage_info.get("Path", "")
        # tusd stores paths as /data/uploads/tus/xxx but backend sees /data/storage/uploads/tus/xxx
        # Map tusd's upload-dir to backend's STORAGE_PATH
        file_path = raw_path.replace("/data/uploads/tus/", f"{settings.STORAGE_PATH}/uploads/tus/")
        file_size = upload.get("Size", 0)

        filename = metadata.get("filename", "unknown")
        filetype = metadata.get("filetype", "")
        folder_id_str = metadata.get("folder_id", "")

        async with async_session() as db:
            user, api_key = await _authenticate_tus_upload(metadata, db)
            if user is None:
                logger.error("tus post-finish: authentication failed for %s", filename)
                return JSONResponse(content={"ok": False})

            file_type = get_file_type(filename)
            folder_uuid = uuid.UUID(folder_id_str) if folder_id_str else None

            # API key folder restriction
            if api_key and api_key.folder_id:
                folder_uuid = api_key.folder_id

            # Copy permissions from folder
            doc_group_id = None
            doc_group_read = False
            doc_group_write = False
            doc_others_read = True
            doc_others_write = False
            if folder_uuid:
                folder_obj = await db.get(Folder, folder_uuid)
                if folder_obj:
                    doc_group_id = folder_obj.group_id
                    doc_group_read = folder_obj.group_read
                    doc_group_write = folder_obj.group_write
                    doc_others_read = folder_obj.others_read
                    doc_others_write = folder_obj.others_write

            # Check for existing document with same title (duplicate handling)
            existing_result = await db.execute(
                select(Document).where(
                    Document.title == filename,
                    Document.deleted_at.is_(None),
                )
            )
            existing_doc = existing_result.scalars().first()

            if existing_doc:
                doc = existing_doc
                # Remove old files
                old_files = await db.execute(select(File).where(File.document_id == doc.id))
                for old_f in old_files.scalars().all():
                    try:
                        Path(old_f.storage_path).unlink(missing_ok=True)
                    except OSError:
                        pass
                    await db.delete(old_f)
                doc.source_path = file_path
                doc.file_type = file_type
                doc.content = ""
                doc.processing_status = "pending"
                doc.updated_by_id = user.id
                doc.updated_at = func.now()
                if folder_uuid is not None:
                    doc.folder_id = folder_uuid
            else:
                doc = Document(
                    title=filename,
                    source_path=file_path,
                    file_type=file_type,
                    content="",
                    owner_id=user.id,
                    group_id=doc_group_id,
                    group_read=doc_group_read,
                    group_write=doc_group_write,
                    others_read=doc_others_read,
                    others_write=doc_others_write,
                    created_by_id=user.id,
                    updated_by_id=user.id,
                    processing_status="pending",
                    folder_id=folder_uuid,
                )
                db.add(doc)

            await db.flush()

            # File record
            db.add(File(
                document_id=doc.id,
                filename=filename,
                storage_path=file_path,
                file_size=file_size,
                mime_type=filetype or None,
            ))

            await db.commit()
            logger.info("tus upload complete: %s (%s), doc_id=%s", filename, file_type, doc.id)

            # Virus scan
            from app.services.antivirus import scan_file
            doc.processing_status = "scanning"
            await db.commit()
            scan_status, scan_message = await scan_file(file_path)
            logger.info("Virus scan result for %s: %s (%s)", filename, scan_status, scan_message)
            doc.scan_status = scan_status
            doc.scan_result = scan_message

            if scan_status == "infected":
                logger.warning("Virus detected in %s: %s — deleting file", filename, scan_message)
                doc.processing_status = "error"
                doc.content = f"ウイルスが検出されました: {scan_message}"
                # Delete the infected file from disk
                try:
                    Path(file_path).unlink(missing_ok=True)
                except OSError:
                    pass
                await db.commit()
                return JSONResponse(content={"ok": False, "error": f"Virus detected: {scan_message}"})

            await db.commit()

            # Start background processing
            background_tasks.add_task(
                process_document_background, doc.id, file_path, file_type, filename
            )

            return JSONResponse(content={"ok": True, "document_id": str(doc.id)})

    # Unknown event type
    return JSONResponse(content={})
