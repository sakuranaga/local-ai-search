import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.db import async_session, get_db
from app.deps import get_current_user
from app.models import Chunk, Document, DocumentTag, File, Folder, Group, Tag, User
from app.services.embedding import get_embeddings
from app.services.llm import generate_summary
from app.services.parser import chunk_text, parse_file
from app.services.permissions import (
    is_admin as _is_admin,
    can_access_document as _check_doc_access,
    get_user_group_ids,
    build_visibility_filter,
    format_permission_string,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/documents", tags=["documents"])

# ---------------------------------------------------------------------------
# Response / request models
# ---------------------------------------------------------------------------


class TagInfo(BaseModel):
    id: int
    name: str
    color: str | None


class DocumentListItem(BaseModel):
    id: str
    title: str
    summary: str | None = None
    source_path: str | None
    file_type: str
    owner_id: str | None = None
    owner_name: str | None = None
    group_id: str | None = None
    group_name: str | None = None
    group_read: bool = False
    group_write: bool = False
    others_read: bool = True
    others_write: bool = False
    permissions: str = "rw--r-"  # Unix-style string
    searchable: bool
    ai_knowledge: bool
    chunk_count: int
    memo: str | None
    folder_id: str | None = None
    folder_name: str | None = None
    tags: list[TagInfo] = []
    created_by_name: str | None
    updated_by_name: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentListResponse(BaseModel):
    items: list[DocumentListItem]
    total: int
    page: int
    per_page: int


class DocumentDetail(DocumentListItem):
    content: str
    files: list[dict]
    chunks: list[dict]


class DocumentUpdateRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    memo: str | None = None
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None
    searchable: bool | None = None
    ai_knowledge: bool | None = None
    folder_id: str | None = None  # UUID string or "" to unset
    tag_ids: list[int] | None = None  # replace all tags


class BulkDeleteRequest(BaseModel):
    ids: list[str]


class BulkActionRequest(BaseModel):
    ids: list[str]
    action: str  # "delete" | "reindex" | "set_permissions" | "move_to_folder" | "add_tags" | "remove_tags" | "set_searchable" | "set_ai_knowledge"
    # For set_permissions action (Unix-style)
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None
    # For move_to_folder action
    folder_id: str | None = None  # "" to unset
    # For add_tags / remove_tags actions
    tag_ids: list[int] | None = None
    # For set_searchable / set_ai_knowledge actions
    searchable: bool | None = None
    ai_knowledge: bool | None = None


class UnixPermissionsRequest(BaseModel):
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_file_type(filename: str) -> str:
    ext = Path(filename).suffix.lower().lstrip(".")
    type_map = {
        "md": "md",
        "markdown": "md",
        "txt": "md",
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
    return type_map.get(ext, "md")


def _make_doc_list_item(
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
        chunk_count=getattr(row, "chunk_count", 0),
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
# 1. GET /documents/ — list with pagination, sorting, filtering
# ---------------------------------------------------------------------------


async def _load_tags_for_docs(db: AsyncSession, doc_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[TagInfo]]:
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


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    sort_by: str = Query("updated_at"),
    sort_dir: str = Query("desc"),
    file_type: str | None = Query(None),
    q: str | None = Query(None),
    folder_id: str | None = Query(None),
    unfiled: bool = Query(False),
    tag: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List documents accessible to the current user with pagination."""

    CreatedByUser = aliased(User)
    UpdatedByUser = aliased(User)
    OwnerUser = aliased(User)

    # Subquery for chunk count
    chunk_count_sq = (
        select(
            Chunk.document_id,
            func.count(Chunk.id).label("chunk_count"),
        )
        .group_by(Chunk.document_id)
        .subquery()
    )

    # Unix visibility filter
    user_group_ids = await get_user_group_ids(db, current_user.id)
    visibility_filter = build_visibility_filter(current_user, user_group_ids)

    # Base query
    base = (
        select(
            Document.id,
            Document.title,
            Document.source_path,
            Document.file_type,
            Document.owner_id,
            OwnerUser.username.label("owner_name"),
            Document.group_id,
            Document.group_read,
            Document.group_write,
            Document.others_read,
            Document.others_write,
            Document.searchable,
            Document.ai_knowledge,
            Document.summary,
            Document.memo,
            Document.folder_id,
            Folder.name.label("folder_name"),
            Group.name.label("group_name"),
            Document.created_at,
            Document.updated_at,
            func.coalesce(chunk_count_sq.c.chunk_count, 0).label("chunk_count"),
            CreatedByUser.username.label("created_by_name"),
            UpdatedByUser.username.label("updated_by_name"),
        )
        .outerjoin(chunk_count_sq, Document.id == chunk_count_sq.c.document_id)
        .outerjoin(CreatedByUser, Document.created_by_id == CreatedByUser.id)
        .outerjoin(UpdatedByUser, Document.updated_by_id == UpdatedByUser.id)
        .outerjoin(OwnerUser, Document.owner_id == OwnerUser.id)
        .outerjoin(Folder, Document.folder_id == Folder.id)
        .outerjoin(Group, Document.group_id == Group.id)
        .where(visibility_filter)
        .where(Document.deleted_at.is_(None))
    )

    # Filters
    if file_type:
        base = base.where(Document.file_type == file_type)
    if q:
        base = base.where(Document.title.ilike(f"%{q}%"))
    if folder_id:
        base = base.where(Document.folder_id == uuid.UUID(folder_id))
    elif unfiled:
        base = base.where(Document.folder_id.is_(None))
    if tag:
        tag_sq = (
            select(DocumentTag.document_id)
            .join(Tag, DocumentTag.tag_id == Tag.id)
            .where(Tag.name == tag)
            .subquery()
        )
        base = base.where(Document.id.in_(select(tag_sq.c.document_id)))

    # Count total before pagination
    count_stmt = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    # Sorting
    allowed_sort_cols = {
        "updated_at": Document.updated_at,
        "created_at": Document.created_at,
        "title": Document.title,
        "file_type": Document.file_type,
    }
    sort_col = allowed_sort_cols.get(sort_by, Document.updated_at)
    if sort_dir.lower() == "asc":
        base = base.order_by(sort_col.asc())
    else:
        base = base.order_by(sort_col.desc())

    # Pagination
    offset = (page - 1) * per_page
    base = base.offset(offset).limit(per_page)

    result = await db.execute(base)
    rows = result.all()

    # Batch-load tags for returned documents
    doc_ids = [row.id for row in rows]
    tags_map = await _load_tags_for_docs(db, doc_ids)

    items = [
        _make_doc_list_item(row, tags=tags_map.get(row.id, []))
        for row in rows
    ]

    return DocumentListResponse(items=items, total=total, page=page, per_page=per_page)


# ---------------------------------------------------------------------------
# 2. POST /documents/upload
# ---------------------------------------------------------------------------


async def _process_document_background(doc_id: uuid.UUID, storage_path: str, file_type: str, filename: str):
    """Background task: parse → chunk → embed → summarize."""
    async with async_session() as db:
        try:
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if not doc:
                logger.warning(f"Background task: document not found {doc_id}")
                return

            # Phase 1: Parse / OCR
            doc.processing_status = "parsing"
            await db.commit()

            try:
                text_content = await parse_file(storage_path, file_type)
            except Exception as e:
                logger.error(f"Parse failed for {filename}: {e}")
                doc.processing_status = "error"
                await db.commit()
                return

            doc.content = text_content

            # Phase 2: Chunking
            doc.processing_status = "chunking"
            await db.commit()

            chunks_text = chunk_text(text_content)

            # Phase 3: Embedding
            doc.processing_status = "embedding"
            await db.commit()

            try:
                embeddings = await get_embeddings(chunks_text)
            except Exception:
                embeddings = [None] * len(chunks_text)

            # Remove old chunks and create new ones
            await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))
            for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
                db.add(Chunk(
                    document_id=doc.id,
                    chunk_index=i,
                    content=chunk_content,
                    embedding=embedding,
                ))

            # Phase 4: Summary
            doc.processing_status = "summarizing"
            await db.commit()

            try:
                summary = await generate_summary(text_content, filename)
                if summary:
                    doc.summary = summary
            except Exception:
                pass

            doc.processing_status = "done"
            await db.commit()
            logger.info(f"Background processing complete: {filename} ({doc_id})")

        except Exception as e:
            logger.error(f"Background processing error for {doc_id}: {e}")
            try:
                doc.processing_status = "error"
                await db.commit()
            except Exception:
                pass


@router.post("/upload", response_model=DocumentListItem, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile,
    background_tasks: BackgroundTasks,
    folder_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a file and return immediately. Processing runs in background."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    file_type = _get_file_type(file.filename)

    # Save uploaded file to storage
    storage_dir = Path(settings.STORAGE_PATH) / "uploads" / str(current_user.id)
    storage_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4()
    # Truncate stored filename to stay within 255-byte filesystem limit
    # UUID (36) + underscore (1) = 37 bytes reserved for prefix
    suffix = Path(file.filename).suffix  # e.g. ".md"
    max_name_bytes = 255 - 37 - len(suffix.encode("utf-8"))
    base_name = Path(file.filename).stem
    truncated = base_name.encode("utf-8")[:max_name_bytes].decode("utf-8", errors="ignore")
    stored_filename = f"{file_id}_{truncated}{suffix}"
    storage_path = storage_dir / stored_filename

    content_bytes = await file.read()
    with open(storage_path, "wb") as f:
        f.write(content_bytes)

    file_size = len(content_bytes)

    # Check for existing document with the same title (duplicate prevention)
    existing_result = await db.execute(
        select(Document).where(
            Document.title == file.filename,
            Document.deleted_at.is_(None),
        )
    )
    existing_doc = existing_result.scalars().first()

    if existing_doc:
        doc = existing_doc

        # Remove old file from disk and DB
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
        doc.updated_by_id = current_user.id
        if folder_id is not None:
            doc.folder_id = folder_id
    else:
        # Copy permissions from folder if uploading into one
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
            owner_id=current_user.id,
            group_id=doc_group_id,
            group_read=doc_group_read,
            group_write=doc_group_write,
            others_read=doc_others_read,
            others_write=doc_others_write,
            created_by_id=current_user.id,
            updated_by_id=current_user.id,
            processing_status="pending",
            folder_id=folder_id,
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

    # Commit now so background task can find the document
    await db.commit()
    await db.refresh(doc)

    # Launch background processing (runs after response is sent)
    background_tasks.add_task(
        _process_document_background, doc.id, str(storage_path), file_type, file.filename
    )

    return DocumentListItem(
        id=str(doc.id),
        title=doc.title,
        summary=doc.summary,
        source_path=doc.source_path,
        file_type=doc.file_type,
        owner_id=str(doc.owner_id) if doc.owner_id else None,
        owner_name=current_user.username,
        group_id=str(doc.group_id) if doc.group_id else None,
        group_read=doc.group_read,
        group_write=doc.group_write,
        others_read=doc.others_read,
        others_write=doc.others_write,
        permissions=format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        chunk_count=0,
        memo=doc.memo,
        created_by_name=current_user.username,
        updated_by_name=current_user.username,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


# ---------------------------------------------------------------------------
# Processing status
# ---------------------------------------------------------------------------


@router.get("/status/{document_id}")
async def get_processing_status(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the background processing status of a document."""
    result = await db.execute(
        select(Document.processing_status).where(Document.id == document_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": row}


@router.post("/check-duplicates")
async def check_duplicates(
    titles: list[str] = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return which of the given titles already exist as documents."""
    if not titles:
        return {"duplicates": []}
    result = await db.execute(
        select(Document.title).where(
            Document.title.in_(titles),
            Document.deleted_at.is_(None),
        )
    )
    found = set(result.scalars().all())
    return {"duplicates": [t for t in titles if t in found]}


# ---------------------------------------------------------------------------
# Trash (soft-deleted documents) — must be before /{document_id} routes
# ---------------------------------------------------------------------------


class TrashItem(BaseModel):
    id: str
    title: str
    file_type: str
    deleted_at: datetime


class TrashActionRequest(BaseModel):
    ids: list[str]


@router.get("/trash/list", response_model=list[TrashItem])
async def list_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List soft-deleted documents (trash)."""
    is_admin = _is_admin(current_user)
    stmt = select(Document).where(Document.deleted_at.is_not(None))
    if not is_admin:
        stmt = stmt.where(Document.owner_id == current_user.id)
    stmt = stmt.order_by(Document.deleted_at.desc())
    result = await db.execute(stmt)
    docs = result.scalars().all()
    return [
        TrashItem(id=str(d.id), title=d.title, file_type=d.file_type, deleted_at=d.deleted_at)
        for d in docs
    ]


@router.post("/trash/restore")
async def restore_from_trash(
    body: TrashActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restore documents from trash."""
    restored = 0
    for doc_id_str in body.ids:
        try:
            doc_id = uuid.UUID(doc_id_str)
        except ValueError:
            continue
        result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_not(None)))
        doc = result.scalar_one_or_none()
        if doc is None:
            continue
        if not _is_admin(current_user) and doc.owner_id != current_user.id:
            continue
        doc.deleted_at = None
        restored += 1
    await db.flush()
    return {"restored": restored}


@router.post("/trash/purge")
async def purge_from_trash(
    body: TrashActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete documents from trash."""
    purged = 0
    for doc_id_str in body.ids:
        try:
            doc_id = uuid.UUID(doc_id_str)
        except ValueError:
            continue
        result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_not(None)))
        doc = result.scalar_one_or_none()
        if doc is None:
            continue
        if not _is_admin(current_user) and doc.owner_id != current_user.id:
            continue
        files_result = await db.execute(select(File).where(File.document_id == doc.id))
        for f in files_result.scalars().all():
            try:
                Path(f.storage_path).unlink(missing_ok=True)
            except OSError:
                pass
        await db.delete(doc)
        purged += 1
    await db.flush()
    return {"purged": purged}


@router.post("/trash/empty")
async def empty_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete all documents in trash."""
    stmt = select(Document).where(Document.deleted_at.is_not(None))
    if not _is_admin(current_user):
        stmt = stmt.where(Document.owner_id == current_user.id)
    result = await db.execute(stmt)
    docs = result.scalars().all()
    purged = 0
    for doc in docs:
        files_result = await db.execute(select(File).where(File.document_id == doc.id))
        for f in files_result.scalars().all():
            try:
                Path(f.storage_path).unlink(missing_ok=True)
            except OSError:
                pass
        await db.delete(doc)
        purged += 1
    await db.flush()
    return {"purged": purged}


# ---------------------------------------------------------------------------
# Download file
# ---------------------------------------------------------------------------


async def _resolve_token_user(request: Request, token: str | None, db: AsyncSession) -> User:
    """Resolve authenticated user from Bearer header or ?token= query param."""
    from app.services.auth import verify_token as _verify

    raw_token = token
    if not raw_token:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            raw_token = auth[7:]
    if not raw_token:
        raise HTTPException(status_code=401, detail="Authentication required")

    payload = _verify(raw_token, expected_type="access")
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token")
    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def _get_doc_file(document_id: uuid.UUID, current_user: User, db: AsyncSession) -> tuple["Document", "File"]:
    """Get document and its file record with access check."""
    result = await db.execute(select(Document).where(Document.id == document_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not await _check_doc_access(doc, current_user, need_write=False, db=db):
        raise HTTPException(status_code=403, detail="Access denied")
    files_result = await db.execute(select(File).where(File.document_id == doc.id))
    file_record = files_result.scalars().first()
    if file_record is None or not Path(file_record.storage_path).exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    return doc, file_record


@router.get("/{document_id}/download")
async def download_document_file(
    request: Request,
    document_id: uuid.UUID,
    token: str | None = Query(None),
    inline: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    """Download the original uploaded file. Supports ?token= and ?inline=true."""
    current_user = await _resolve_token_user(request, token, db)
    _, file_record = await _get_doc_file(document_id, current_user, db)

    resp = FileResponse(
        path=file_record.storage_path,
        filename=file_record.filename if not inline else None,
        media_type=file_record.mime_type or "application/octet-stream",
    )
    if inline:
        resp.headers["Content-Disposition"] = "inline"
    return resp


@router.get("/{document_id}/preview")
async def preview_document(
    request: Request,
    document_id: uuid.UUID,
    token: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Return an HTML preview for Excel/PowerPoint files."""
    from fastapi.responses import HTMLResponse
    from app.services.preview import render_preview_html

    current_user = await _resolve_token_user(request, token, db)
    doc, file_record = await _get_doc_file(document_id, current_user, db)

    html = await render_preview_html(file_record.storage_path, doc.file_type)
    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# 3. GET /documents/{id}
# ---------------------------------------------------------------------------


@router.get("/{document_id}", response_model=DocumentDetail)
async def get_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get full document details including chunks and files."""
    result = await db.execute(select(Document).where(Document.id == document_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=False, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Get chunks
    chunks_result = await db.execute(
        select(Chunk).where(Chunk.document_id == doc.id).order_by(Chunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()

    # Get files
    files_result = await db.execute(select(File).where(File.document_id == doc.id))
    files = files_result.scalars().all()

    # Get owner name
    owner_name = None
    if doc.owner_id:
        r = await db.execute(select(User.username).where(User.id == doc.owner_id))
        owner_name = r.scalar_one_or_none()

    # Get created_by / updated_by names
    created_by_name = None
    updated_by_name = None
    if doc.created_by_id:
        r = await db.execute(select(User.username).where(User.id == doc.created_by_id))
        created_by_name = r.scalar_one_or_none()
    if doc.updated_by_id:
        r = await db.execute(select(User.username).where(User.id == doc.updated_by_id))
        updated_by_name = r.scalar_one_or_none()

    # Load folder name
    folder_name = None
    if doc.folder_id:
        r = await db.execute(select(Folder.name).where(Folder.id == doc.folder_id))
        folder_name = r.scalar_one_or_none()

    # Load tags
    tags_map = await _load_tags_for_docs(db, [doc.id])
    doc_tags = tags_map.get(doc.id, [])

    # Get group name
    group_name = None
    if doc.group_id:
        r = await db.execute(select(Group.name).where(Group.id == doc.group_id))
        group_name = r.scalar_one_or_none()

    return DocumentDetail(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        owner_id=str(doc.owner_id) if doc.owner_id else None,
        owner_name=owner_name,
        group_id=str(doc.group_id) if doc.group_id else None,
        group_name=group_name,
        group_read=doc.group_read,
        group_write=doc.group_write,
        others_read=doc.others_read,
        others_write=doc.others_write,
        permissions=format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        content=doc.content,
        chunk_count=len(chunks),
        memo=doc.memo,
        folder_id=str(doc.folder_id) if doc.folder_id else None,
        folder_name=folder_name,
        tags=doc_tags,
        created_by_name=created_by_name,
        updated_by_name=updated_by_name,
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


# ---------------------------------------------------------------------------
# 4. PATCH /documents/{id} — update title, memo, permissions
# ---------------------------------------------------------------------------


@router.patch("/{document_id}", response_model=DocumentListItem)
async def update_document(
    document_id: uuid.UUID,
    body: DocumentUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update document metadata. Requires ownership, write permission, or admin."""
    result = await db.execute(select(Document).where(Document.id == document_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    if body.title is not None:
        doc.title = body.title
    if body.summary is not None:
        doc.summary = body.summary
    if body.memo is not None:
        doc.memo = body.memo
    if body.group_id is not None:
        doc.group_id = uuid.UUID(body.group_id) if body.group_id else None
    if body.group_read is not None:
        doc.group_read = body.group_read
    if body.group_write is not None:
        doc.group_write = body.group_write
    if body.others_read is not None:
        doc.others_read = body.others_read
    if body.others_write is not None:
        doc.others_write = body.others_write
    if body.searchable is not None:
        doc.searchable = body.searchable
    if body.ai_knowledge is not None:
        doc.ai_knowledge = body.ai_knowledge
    if body.folder_id is not None:
        doc.folder_id = uuid.UUID(body.folder_id) if body.folder_id else None
    if body.tag_ids is not None:
        await db.execute(
            delete(DocumentTag).where(DocumentTag.document_id == doc.id)
        )
        for tid in body.tag_ids:
            db.add(DocumentTag(document_id=doc.id, tag_id=tid))

    doc.updated_by_id = current_user.id

    await db.flush()
    await db.refresh(doc)

    # chunk count
    chunk_count = (
        await db.execute(
            select(func.count(Chunk.id)).where(Chunk.document_id == doc.id)
        )
    ).scalar() or 0

    # folder name
    folder_name = None
    if doc.folder_id:
        r = await db.execute(select(Folder.name).where(Folder.id == doc.folder_id))
        folder_name = r.scalar_one_or_none()

    # tags
    tags_map = await _load_tags_for_docs(db, [doc.id])

    # group name
    group_name = None
    if doc.group_id:
        r = await db.execute(select(Group.name).where(Group.id == doc.group_id))
        group_name = r.scalar_one_or_none()

    # Owner name
    _owner_name = None
    if doc.owner_id:
        _r = await db.execute(select(User.username).where(User.id == doc.owner_id))
        _owner_name = _r.scalar_one_or_none()

    return DocumentListItem(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        owner_id=str(doc.owner_id) if doc.owner_id else None,
        owner_name=_owner_name,
        group_id=str(doc.group_id) if doc.group_id else None,
        group_name=group_name,
        group_read=doc.group_read,
        group_write=doc.group_write,
        others_read=doc.others_read,
        others_write=doc.others_write,
        permissions=format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        chunk_count=chunk_count,
        memo=doc.memo,
        folder_id=str(doc.folder_id) if doc.folder_id else None,
        folder_name=folder_name,
        tags=tags_map.get(doc.id, []),
        created_by_name=None,
        updated_by_name=current_user.username,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


# ---------------------------------------------------------------------------
# 5. DELETE /documents/{id}
# ---------------------------------------------------------------------------


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete a document (move to trash)."""
    result = await db.execute(select(Document).where(Document.id == document_id, Document.deleted_at.is_(None)))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    doc.deleted_at = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# 6. POST /documents/bulk-delete
# ---------------------------------------------------------------------------


@router.post("/bulk-delete")
async def bulk_delete_documents(
    body: BulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete multiple documents (move to trash)."""
    deleted = 0
    now = datetime.now(timezone.utc)

    for doc_id_str in body.ids:
        try:
            doc_id = uuid.UUID(doc_id_str)
        except ValueError:
            continue

        result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_(None)))
        doc = result.scalar_one_or_none()
        if doc is None:
            continue

        if not await _check_doc_access(doc, current_user, need_write=True, db=db):
            continue

        doc.deleted_at = now
        deleted += 1

    await db.flush()
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# 6b. POST /documents/bulk-action — unified bulk operations
# ---------------------------------------------------------------------------


@router.post("/bulk-action")
async def bulk_action(
    body: BulkActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Perform bulk action on multiple documents.

    Actions: delete, reindex, set_permissions
    """
    if body.action == "delete":
        deleted = 0
        now = datetime.now(timezone.utc)
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id, Document.deleted_at.is_(None)))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue
            doc.deleted_at = now
            deleted += 1
        await db.flush()
        return {"action": "delete", "processed": deleted}

    elif body.action == "reindex":
        processed = 0
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue

            text_content = doc.content
            if doc.source_path and Path(doc.source_path).exists():
                try:
                    text_content = await parse_file(doc.source_path, doc.file_type)
                    doc.content = text_content
                except Exception:
                    pass

            await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))
            chunks_text = chunk_text(text_content)
            try:
                embeddings = await get_embeddings(chunks_text)
            except Exception:
                embeddings = [None] * len(chunks_text)
            for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
                db.add(Chunk(
                    document_id=doc.id,
                    chunk_index=i,
                    content=chunk_content,
                    embedding=embedding,
                ))
            doc.updated_by_id = current_user.id
            processed += 1
        await db.flush()
        return {"action": "reindex", "processed": processed}

    elif body.action == "set_permissions":
        processed = 0
        group_uuid = uuid.UUID(body.group_id) if body.group_id else None
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if doc.owner_id != current_user.id and not _is_admin(current_user):
                continue
            original_updated_at = doc.updated_at
            if body.group_id is not None:
                doc.group_id = group_uuid
            if body.group_read is not None:
                doc.group_read = body.group_read
            if body.group_write is not None:
                doc.group_write = body.group_write
            if body.others_read is not None:
                doc.others_read = body.others_read
            if body.others_write is not None:
                doc.others_write = body.others_write
            doc.updated_at = original_updated_at
            processed += 1
        await db.flush()
        return {"action": "set_permissions", "processed": processed}

    elif body.action == "move_to_folder":
        folder_uuid = uuid.UUID(body.folder_id) if body.folder_id else None
        # Load target folder to copy permissions
        target_folder = None
        if folder_uuid:
            target_folder = await db.get(Folder, folder_uuid)
        processed = 0
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue
            original_updated_at = doc.updated_at
            doc.folder_id = folder_uuid
            # Apply target folder permissions
            if target_folder:
                doc.group_id = target_folder.group_id
                doc.group_read = target_folder.group_read
                doc.group_write = target_folder.group_write
                doc.others_read = target_folder.others_read
                doc.others_write = target_folder.others_write
            # Preserve original updated_at (folder move is not a content change)
            doc.updated_at = original_updated_at
            processed += 1
        await db.flush()
        return {"action": "move_to_folder", "processed": processed}

    elif body.action == "add_tags":
        if not body.tag_ids:
            raise HTTPException(status_code=400, detail="tag_ids required")
        processed = 0
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue
            existing = await db.execute(
                select(DocumentTag.tag_id).where(DocumentTag.document_id == doc_id)
            )
            existing_ids = {row[0] for row in existing.all()}
            for tid in body.tag_ids:
                if tid not in existing_ids:
                    db.add(DocumentTag(document_id=doc_id, tag_id=tid))
            processed += 1
        await db.flush()
        return {"action": "add_tags", "processed": processed}

    elif body.action == "remove_tags":
        if not body.tag_ids:
            raise HTTPException(status_code=400, detail="tag_ids required")
        processed = 0
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue
            await db.execute(
                delete(DocumentTag).where(
                    DocumentTag.document_id == doc_id,
                    DocumentTag.tag_id.in_(body.tag_ids),
                )
            )
            processed += 1
        await db.flush()
        return {"action": "remove_tags", "processed": processed}

    elif body.action in ("set_searchable", "set_ai_knowledge"):
        field = "searchable" if body.action == "set_searchable" else "ai_knowledge"
        new_val = body.searchable if field == "searchable" else body.ai_knowledge
        if new_val is None:
            raise HTTPException(status_code=400, detail=f"{field} required")
        processed = 0
        for doc_id_str in body.ids:
            try:
                doc_id = uuid.UUID(doc_id_str)
            except ValueError:
                continue
            result = await db.execute(select(Document).where(Document.id == doc_id))
            doc = result.scalar_one_or_none()
            if doc is None:
                continue
            if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                continue
            original_updated_at = doc.updated_at
            setattr(doc, field, new_val)
            doc.updated_at = original_updated_at
            processed += 1
        await db.flush()
        return {"action": body.action, "processed": processed}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")


# ---------------------------------------------------------------------------
# 7. GET /documents/{id}/permissions — Unix-style permissions
# ---------------------------------------------------------------------------


@router.get("/{document_id}/permissions")
async def get_document_permissions(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return Unix-style permissions for the document."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not await _check_doc_access(doc, current_user, need_write=False, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Owner info
    owner_name = None
    if doc.owner_id:
        r = await db.execute(select(User.username).where(User.id == doc.owner_id))
        owner_name = r.scalar_one_or_none()

    # Group info
    group_name = None
    if doc.group_id:
        r = await db.execute(select(Group.name).where(Group.id == doc.group_id))
        group_name = r.scalar_one_or_none()

    return {
        "owner_id": str(doc.owner_id) if doc.owner_id else None,
        "owner_name": owner_name,
        "group_id": str(doc.group_id) if doc.group_id else None,
        "group_name": group_name,
        "group_read": doc.group_read,
        "group_write": doc.group_write,
        "others_read": doc.others_read,
        "others_write": doc.others_write,
        "permissions": format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
    }


# ---------------------------------------------------------------------------
# 8. PATCH /documents/{id}/permissions — Unix-style permissions update
# ---------------------------------------------------------------------------


@router.patch("/{document_id}/permissions")
async def set_document_permissions(
    document_id: uuid.UUID,
    body: UnixPermissionsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update Unix-style permissions for the document. Owner or admin only."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    effective_owner = doc.owner_id or doc.created_by_id
    if effective_owner != current_user.id and not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    if body.group_id is not None:
        doc.group_id = uuid.UUID(body.group_id) if body.group_id else None
    if body.group_read is not None:
        doc.group_read = body.group_read
    if body.group_write is not None:
        doc.group_write = body.group_write
    if body.others_read is not None:
        doc.others_read = body.others_read
    if body.others_write is not None:
        doc.others_write = body.others_write

    await db.flush()
    return {
        "status": "ok",
        "permissions": format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
    }


# ---------------------------------------------------------------------------
# 9. POST /documents/{id}/reindex
# ---------------------------------------------------------------------------


@router.post("/{document_id}/reindex", response_model=DocumentListItem)
async def reindex_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-chunk and re-embed a single document."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Re-parse content from source_path if available, else use stored content
    text_content = doc.content
    if doc.source_path and Path(doc.source_path).exists():
        try:
            text_content = await parse_file(doc.source_path, doc.file_type)
            doc.content = text_content
        except Exception:
            pass  # fall back to stored content

    # Delete existing chunks
    await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))

    # Re-chunk
    chunks_text = chunk_text(text_content)

    # Get embeddings
    try:
        embeddings = await get_embeddings(chunks_text)
    except Exception:
        embeddings = [None] * len(chunks_text)

    # Create new chunk records
    for i, (chunk_content, embedding) in enumerate(zip(chunks_text, embeddings)):
        chunk = Chunk(
            document_id=doc.id,
            chunk_index=i,
            content=chunk_content,
            embedding=embedding,
        )
        db.add(chunk)

    doc.updated_by_id = current_user.id

    await db.flush()
    await db.refresh(doc)

    return DocumentListItem(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        owner_id=str(doc.owner_id) if doc.owner_id else None,
        owner_name=current_user.username,
        group_id=str(doc.group_id) if doc.group_id else None,
        group_read=doc.group_read,
        group_write=doc.group_write,
        others_read=doc.others_read,
        others_write=doc.others_write,
        permissions=format_permission_string(doc.group_read, doc.group_write, doc.others_read, doc.others_write),
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        chunk_count=len(chunks_text),
        memo=doc.memo,
        created_by_name=None,
        updated_by_name=current_user.username,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )
