import asyncio
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.db import get_db
from app.deps import get_current_user
from app.models import Chunk, Document, DocumentTag, File, Folder, Group, Tag, User, UserFavorite
from app.schemas.documents import (
    BulkActionRequest,
    CreateTextDocumentRequest,
    DocumentDetail,
    DocumentListItem,
    DocumentListResponse,
    DocumentUpdateRequest,
    TagInfo,
    TrashActionRequest,
    TrashItem,
    UnixPermissionsRequest,
)
from app.services.document_processing import (
    get_file_type,
    load_tags_for_docs,
    make_doc_list_item,
    process_document_background,
)
from app.services.audit import audit_log
from app.services.embedding import get_embeddings
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
# 1. GET /documents/ — list with pagination, sorting, filtering
# ---------------------------------------------------------------------------


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
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    created_by: str | None = Query(None),
    favorites: bool = Query(False),
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

    # Subquery for file size (sum of all files per document)
    file_size_sq = (
        select(
            File.document_id,
            func.sum(File.file_size).label("file_size"),
        )
        .group_by(File.document_id)
        .subquery()
    )

    # Subquery for active share link count
    from app.models import ShareLink
    share_count_sq = (
        select(
            ShareLink.document_id,
            func.count(ShareLink.id).label("share_count"),
        )
        .where(ShareLink.is_active.is_(True))
        .group_by(ShareLink.document_id)
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
            func.coalesce(func.nullif(OwnerUser.display_name, ""), OwnerUser.username).label("owner_name"),
            Document.group_id,
            Document.group_read,
            Document.group_write,
            Document.others_read,
            Document.others_write,
            Document.searchable,
            Document.ai_knowledge,
            Document.share_prohibited,
            Document.download_prohibited,
            Document.scan_status,
            Document.summary,
            Document.memo,
            Document.folder_id,
            Folder.name.label("folder_name"),
            Group.name.label("group_name"),
            Document.created_at,
            Document.updated_at,
            file_size_sq.c.file_size.label("file_size"),
            func.coalesce(chunk_count_sq.c.chunk_count, 0).label("chunk_count"),
            func.coalesce(share_count_sq.c.share_count, 0).label("share_count"),
            func.coalesce(func.nullif(CreatedByUser.display_name, ""), CreatedByUser.username).label("created_by_name"),
            func.coalesce(func.nullif(UpdatedByUser.display_name, ""), UpdatedByUser.username).label("updated_by_name"),
        )
        .outerjoin(file_size_sq, Document.id == file_size_sq.c.document_id)
        .outerjoin(chunk_count_sq, Document.id == chunk_count_sq.c.document_id)
        .outerjoin(share_count_sq, Document.id == share_count_sq.c.document_id)
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
    if date_from:
        base = base.where(Document.updated_at >= datetime.fromisoformat(date_from))
    if date_to:
        base = base.where(Document.updated_at < datetime.fromisoformat(date_to + "T23:59:59.999999"))
    if created_by:
        base = base.where(Document.created_by_id == uuid.UUID(created_by))
    if tag:
        tag_sq = (
            select(DocumentTag.document_id)
            .join(Tag, DocumentTag.tag_id == Tag.id)
            .where(Tag.name == tag)
            .subquery()
        )
        base = base.where(Document.id.in_(select(tag_sq.c.document_id)))
    if favorites:
        fav_sq = (
            select(UserFavorite.document_id)
            .where(UserFavorite.user_id == current_user.id)
            .subquery()
        )
        base = base.where(Document.id.in_(select(fav_sq.c.document_id)))

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
        base = base.order_by(sort_col.asc(), Document.id.asc())
    else:
        base = base.order_by(sort_col.desc(), Document.id.desc())

    # Pagination
    offset = (page - 1) * per_page
    base = base.offset(offset).limit(per_page)

    result = await db.execute(base)
    rows = result.all()

    # Batch-load tags for returned documents
    doc_ids = [row.id for row in rows]
    tags_map = await load_tags_for_docs(db, doc_ids)

    items = [
        make_doc_list_item(row, tags=tags_map.get(row.id, []))
        for row in rows
    ]

    return DocumentListResponse(items=items, total=total, page=page, per_page=per_page)


# ---------------------------------------------------------------------------
# 2. POST /documents/upload
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Create text document (from editor, saved as .md)
# ---------------------------------------------------------------------------


@router.post("/create-text", response_model=DocumentListItem, status_code=status.HTTP_201_CREATED)
async def create_text_document(
    request: Request,
    body: CreateTextDocumentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new markdown document from text content."""
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    if not title.endswith(".md"):
        title += ".md"

    folder_id = uuid.UUID(body.folder_id) if body.folder_id else None

    # Write content to disk as .md
    storage_dir = Path(settings.STORAGE_PATH) / "uploads" / str(current_user.id)
    storage_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4()
    suffix = ".md"
    max_name_bytes = 255 - 37 - len(suffix.encode("utf-8"))
    base_name = Path(title).stem
    truncated = base_name.encode("utf-8")[:max_name_bytes].decode("utf-8", errors="ignore")
    stored_filename = f"{file_id}_{truncated}{suffix}"
    storage_path = storage_dir / stored_filename

    content_bytes = body.content.encode("utf-8")
    with open(storage_path, "wb") as f:
        f.write(content_bytes)

    file_size = len(content_bytes)

    # Check for existing document with the same title
    existing_result = await db.execute(
        select(Document).where(
            Document.title == title,
            Document.deleted_at.is_(None),
        )
    )
    existing_doc = existing_result.scalars().first()

    if existing_doc:
        doc = existing_doc
        old_files = await db.execute(select(File).where(File.document_id == doc.id))
        for old_f in old_files.scalars().all():
            try:
                Path(old_f.storage_path).unlink(missing_ok=True)
            except OSError:
                pass
            await db.delete(old_f)
        doc.source_path = str(storage_path)
        doc.file_type = "md"
        doc.content = ""
        doc.processing_status = "pending"
        doc.updated_by_id = current_user.id
        doc.updated_at = func.now()
        if folder_id is not None:
            doc.folder_id = folder_id
    else:
        from app.services.settings import get_setting
        default_share_prohibited = (await get_setting(db, "default_share_prohibited")).lower() == "true"
        default_download_prohibited = (await get_setting(db, "default_download_prohibited")).lower() == "true"

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
            title=title,
            source_path=str(storage_path),
            file_type="md",
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
            share_prohibited=default_share_prohibited,
            download_prohibited=default_download_prohibited,
        )
        db.add(doc)
    await db.flush()

    file_record = File(
        document_id=doc.id,
        filename=title,
        storage_path=str(storage_path),
        file_size=file_size,
        mime_type="text/markdown",
    )
    db.add(file_record)

    await audit_log(db, user=current_user, action="document.create", target_type="document",
                    target_id=str(doc.id), target_name=doc.title, request=request)

    await db.commit()
    await db.refresh(doc)

    asyncio.create_task(
        process_document_background(doc.id, str(storage_path), "md", title)
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
# Filter options (for frontend dropdowns)
# ---------------------------------------------------------------------------


@router.get("/filter-options")
async def get_filter_options(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return distinct file types and creators for filter dropdowns."""
    # Distinct file types
    ft_result = await db.execute(
        select(Document.file_type)
        .where(Document.deleted_at.is_(None))
        .group_by(Document.file_type)
        .order_by(Document.file_type)
    )
    file_types = [row[0] for row in ft_result.all()]

    # Distinct creators
    creators_result = await db.execute(
        select(User.id, User.username)
        .join(Document, Document.created_by_id == User.id)
        .where(Document.deleted_at.is_(None))
        .group_by(User.id, User.username)
        .order_by(User.username)
    )
    creators = [{"id": str(row[0]), "name": row[1]} for row in creators_result.all()]

    return {"file_types": file_types, "creators": creators}


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
    request: Request,
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
        await audit_log(db, user=current_user, action="document.restore", target_type="document",
                        target_id=str(doc.id), target_name=doc.title, request=request)
        restored += 1
    await db.flush()
    return {"restored": restored}


@router.post("/trash/purge")
async def purge_from_trash(
    body: TrashActionRequest,
    request: Request,
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
        from app.services.preview_generator import delete_preview_images
        delete_preview_images(str(doc.id))
        await audit_log(db, user=current_user, action="document.purge", target_type="document",
                        target_id=str(doc.id), target_name=doc.title, request=request)
        await db.delete(doc)
        purged += 1
    await db.flush()
    return {"purged": purged}


@router.post("/trash/empty")
async def empty_trash(
    request: Request,
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
        from app.services.preview_generator import delete_preview_images
        delete_preview_images(str(doc.id))
        await audit_log(db, user=current_user, action="document.purge", target_type="document",
                        target_id=str(doc.id), target_name=doc.title, request=request)
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
    doc, file_record = await _get_doc_file(document_id, current_user, db)

    # Check download restrictions (inline preview is always allowed)
    if not inline:
        if doc.download_prohibited:
            raise HTTPException(status_code=403, detail="このファイルはダウンロードが禁止されています")
        if not _is_admin(current_user) and not current_user.can_download:
            raise HTTPException(status_code=403, detail="ダウンロード権限がありません")

    resp = FileResponse(
        path=file_record.storage_path,
        filename=file_record.filename if not inline else None,
        media_type=file_record.mime_type or "application/octet-stream",
    )
    if inline:
        resp.headers["Content-Disposition"] = "inline"
    return resp


@router.post("/download-zip")
async def download_zip(
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download multiple documents as a zip file."""
    import io
    import zipfile
    from fastapi.responses import StreamingResponse as ZipStreamingResponse

    # Check user download permission
    if not _is_admin(current_user) and not current_user.can_download:
        raise HTTPException(status_code=403, detail="ダウンロード権限がありません")

    doc_ids = body.get("ids", [])
    if not doc_ids:
        raise HTTPException(status_code=400, detail="No document IDs provided")

    # Fetch documents and files
    uuids = [uuid.UUID(d) for d in doc_ids]
    result = await db.execute(
        select(Document, File)
        .join(File, File.document_id == Document.id)
        .where(Document.id.in_(uuids), Document.deleted_at.is_(None))
    )
    rows = result.all()

    buf = io.BytesIO()
    seen_names: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for doc, file_record in rows:
            if not await _check_doc_access(doc, current_user, need_write=False, db=db):
                continue
            if doc.download_prohibited:
                continue
            fpath = Path(file_record.storage_path)
            if not fpath.exists():
                continue
            # Deduplicate filenames
            name = file_record.filename or doc.title
            if name in seen_names:
                seen_names[name] += 1
                stem = Path(name).stem
                suffix = Path(name).suffix
                name = f"{stem} ({seen_names[name]}){suffix}"
            else:
                seen_names[name] = 0
            zf.write(fpath, name)

    buf.seek(0)
    return ZipStreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="documents.zip"'},
    )


@router.get("/{document_id}/preview")
async def preview_document(
    request: Request,
    document_id: uuid.UUID,
    token: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Return an HTML preview for office documents.

    Uses pre-generated LibreOffice images if available, falling back to
    text-based rendering.
    """
    from fastapi.responses import HTMLResponse
    from app.services.preview import render_preview_html
    from app.services.preview_generator import get_preview_images

    current_user = await _resolve_token_user(request, token, db)
    doc, file_record = await _get_doc_file(document_id, current_user, db)

    # Try pre-generated image preview first
    images = get_preview_images(str(document_id))
    if images:
        token_qs = f"?token={token}" if token else ""
        img_tags = []
        for i in range(len(images)):
            src = f"/api/documents/{document_id}/preview/image/{i}{token_qs}"
            img_tags.append(
                f'<div class="page">'
                f'<div class="page-num">Page {i + 1} / {len(images)}</div>'
                f'<img src="{src}" alt="Page {i + 1}">'
                f'</div>'
            )
        html = _IMAGE_PREVIEW_TEMPLATE.format(content="\n".join(img_tags))
        return HTMLResponse(content=html)

    # Fallback to text-based preview
    html = await render_preview_html(file_record.storage_path, doc.file_type)
    return HTMLResponse(content=html)


_IMAGE_PREVIEW_TEMPLATE = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<style>
  body {{ margin: 0; padding: 16px; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #1a1a1a; color: #e0e0e0; }} }}
  .page {{ margin-bottom: 16px; text-align: center; }}
  .page img {{ max-width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border-radius: 4px; background: #fff; }}
  @media (prefers-color-scheme: dark) {{ .page img {{ box-shadow: 0 2px 8px rgba(0,0,0,0.4); }} }}
  .page-num {{ font-size: 12px; color: #888; margin-bottom: 6px; }}
</style>
</head>
<body>{content}</body>
</html>"""


@router.get("/{document_id}/preview/image/{page}")
async def preview_image(
    request: Request,
    document_id: uuid.UUID,
    page: int,
    token: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Serve a single preview page image."""
    from fastapi.responses import FileResponse
    from app.services.preview_generator import get_preview_images

    current_user = await _resolve_token_user(request, token, db)
    await _get_doc_file(document_id, current_user, db)

    images = get_preview_images(str(document_id))
    if not images or page < 0 or page >= len(images):
        raise HTTPException(status_code=404, detail="Preview image not found")

    return FileResponse(images[page], media_type="image/png")


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
    from sqlalchemy.orm import aliased
    OwnerUser = aliased(User)
    CreatedByUser = aliased(User)
    UpdatedByUser = aliased(User)

    # Single query with JOINs for all related names (replaces 5 individual SELECTs)
    result = await db.execute(
        select(
            Document,
            func.coalesce(func.nullif(OwnerUser.display_name, ""), OwnerUser.username).label("owner_name"),
            func.coalesce(func.nullif(CreatedByUser.display_name, ""), CreatedByUser.username).label("created_by_name"),
            func.coalesce(func.nullif(UpdatedByUser.display_name, ""), UpdatedByUser.username).label("updated_by_name"),
            Folder.name.label("folder_name"),
            Group.name.label("group_name"),
        )
        .outerjoin(OwnerUser, Document.owner_id == OwnerUser.id)
        .outerjoin(CreatedByUser, Document.created_by_id == CreatedByUser.id)
        .outerjoin(UpdatedByUser, Document.updated_by_id == UpdatedByUser.id)
        .outerjoin(Folder, Document.folder_id == Folder.id)
        .outerjoin(Group, Document.group_id == Group.id)
        .where(Document.id == document_id, Document.deleted_at.is_(None))
    )
    row = result.one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="Document not found")

    doc = row[0]

    if not await _check_doc_access(doc, current_user, need_write=False, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Get chunks and files
    chunks_result = await db.execute(
        select(Chunk).where(Chunk.document_id == doc.id).order_by(Chunk.chunk_index)
    )
    chunks = chunks_result.scalars().all()

    files_result = await db.execute(select(File).where(File.document_id == doc.id))
    files = files_result.scalars().all()

    # Load tags
    tags_map = await load_tags_for_docs(db, [doc.id])
    doc_tags = tags_map.get(doc.id, [])

    return DocumentDetail(
        id=str(doc.id),
        title=doc.title,
        summary=doc.summary,
        source_path=doc.source_path,
        file_type=doc.file_type,
        owner_id=str(doc.owner_id) if doc.owner_id else None,
        owner_name=row.owner_name,
        group_id=str(doc.group_id) if doc.group_id else None,
        group_name=row.group_name,
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
        folder_name=row.folder_name,
        tags=doc_tags,
        created_by_name=row.created_by_name,
        updated_by_name=row.updated_by_name,
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
    request: Request,
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

    # Content-level changes update updated_at; metadata-only changes do not.
    is_content_change = False

    if body.title is not None:
        doc.title = body.title
        is_content_change = True
    if body.summary is not None:
        doc.summary = body.summary
        is_content_change = True
    if body.memo is not None:
        doc.memo = body.memo
        is_content_change = True
    if body.content is not None:
        doc.content = body.content
        is_content_change = True
        # Re-chunk and re-embed
        await db.execute(delete(Chunk).where(Chunk.document_id == doc.id))
        chunks_text = chunk_text(body.content)
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
    if body.share_prohibited is not None:
        doc.share_prohibited = body.share_prohibited
    if body.download_prohibited is not None:
        doc.download_prohibited = body.download_prohibited
    if body.folder_id is not None:
        doc.folder_id = uuid.UUID(body.folder_id) if body.folder_id else None
    if body.tag_ids is not None:
        await db.execute(
            delete(DocumentTag).where(DocumentTag.document_id == doc.id)
        )
        for tid in body.tag_ids:
            db.add(DocumentTag(document_id=doc.id, tag_id=tid))

    if is_content_change:
        doc.updated_by_id = current_user.id
        doc.updated_at = func.now()

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
    tags_map = await load_tags_for_docs(db, [doc.id])

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

    await audit_log(db, user=current_user, action="document.update", target_type="document",
                    target_id=str(doc.id), target_name=doc.title, request=request)

    from app.services.mail import notify_update
    notify_update(current_user.display_name or current_user.username, [doc.title])

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
    request: Request,
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

    await audit_log(db, user=current_user, action="document.delete", target_type="document",
                    target_id=str(doc.id), target_name=doc.title, request=request)

    from app.services.mail import notify_delete
    notify_delete(current_user.display_name or current_user.username, [doc.title])


# ---------------------------------------------------------------------------
# 6. POST /documents/bulk-action — unified bulk operations
# ---------------------------------------------------------------------------


@router.post("/bulk-action")
async def bulk_action(
    body: BulkActionRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Perform bulk action on multiple documents.

    Actions: delete, reindex, set_permissions
    """
    # --- Batch-fetch all requested documents in one query ---
    doc_uuids = []
    for doc_id_str in body.ids:
        try:
            doc_uuids.append(uuid.UUID(doc_id_str))
        except ValueError:
            continue

    if not doc_uuids:
        return {"action": body.action, "processed": 0}

    result = await db.execute(
        select(Document).where(Document.id.in_(doc_uuids))
    )
    all_docs = {doc.id: doc for doc in result.scalars().all()}

    # Filter by access permission (write access required for all bulk actions)
    async def _accessible_docs(need_owner_only: bool = False) -> list[Document]:
        docs = []
        for uid in doc_uuids:
            doc = all_docs.get(uid)
            if doc is None:
                continue
            if need_owner_only:
                if doc.owner_id != current_user.id and not _is_admin(current_user):
                    continue
            else:
                if not await _check_doc_access(doc, current_user, need_write=True, db=db):
                    continue
            docs.append(doc)
        return docs

    if body.action == "delete":
        docs = [d for d in (await _accessible_docs()) if d.deleted_at is None]
        now = datetime.now(timezone.utc)
        for doc in docs:
            doc.deleted_at = now
            await audit_log(db, user=current_user, action="document.delete", target_type="document",
                            target_id=str(doc.id), target_name=doc.title, request=request)
        await db.flush()
        if docs:
            from app.services.mail import notify_delete
            notify_delete(current_user.display_name or current_user.username, [d.title for d in docs])
        return {"action": "delete", "processed": len(docs)}

    elif body.action == "reindex":
        docs = await _accessible_docs()
        for doc in docs:
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
            doc.updated_at = func.now()
        await db.flush()
        return {"action": "reindex", "processed": len(docs)}

    elif body.action == "set_permissions":
        docs = await _accessible_docs(need_owner_only=True)
        group_uuid = uuid.UUID(body.group_id) if body.group_id else None
        for doc in docs:
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
        await db.flush()
        return {"action": "set_permissions", "processed": len(docs)}

    elif body.action == "move_to_folder":
        docs = await _accessible_docs()
        folder_uuid = uuid.UUID(body.folder_id) if body.folder_id else None
        target_folder = await db.get(Folder, folder_uuid) if folder_uuid else None
        for doc in docs:
            doc.folder_id = folder_uuid
            if target_folder:
                doc.group_id = target_folder.group_id
                doc.group_read = target_folder.group_read
                doc.group_write = target_folder.group_write
                doc.others_read = target_folder.others_read
                doc.others_write = target_folder.others_write
        await db.flush()
        return {"action": "move_to_folder", "processed": len(docs)}

    elif body.action == "add_tags":
        if not body.tag_ids:
            raise HTTPException(status_code=400, detail="tag_ids required")
        docs = await _accessible_docs()
        doc_ids = [doc.id for doc in docs]
        # Batch-load existing tags for all documents
        existing_result = await db.execute(
            select(DocumentTag.document_id, DocumentTag.tag_id)
            .where(DocumentTag.document_id.in_(doc_ids))
        )
        existing_map: dict[uuid.UUID, set[int]] = {}
        for row in existing_result.all():
            existing_map.setdefault(row[0], set()).add(row[1])
        for doc in docs:
            existing_ids = existing_map.get(doc.id, set())
            for tid in body.tag_ids:
                if tid not in existing_ids:
                    db.add(DocumentTag(document_id=doc.id, tag_id=tid))
        await db.flush()
        return {"action": "add_tags", "processed": len(docs)}

    elif body.action == "remove_tags":
        if not body.tag_ids:
            raise HTTPException(status_code=400, detail="tag_ids required")
        docs = await _accessible_docs()
        doc_ids = [doc.id for doc in docs]
        if doc_ids:
            await db.execute(
                delete(DocumentTag).where(
                    DocumentTag.document_id.in_(doc_ids),
                    DocumentTag.tag_id.in_(body.tag_ids),
                )
            )
        await db.flush()
        return {"action": "remove_tags", "processed": len(docs)}

    elif body.action == "set_tags":
        if body.tag_ids is None:
            raise HTTPException(status_code=400, detail="tag_ids required")
        docs = await _accessible_docs()
        doc_ids = [doc.id for doc in docs]
        if doc_ids:
            # Batch delete all existing tags
            await db.execute(
                delete(DocumentTag).where(DocumentTag.document_id.in_(doc_ids))
            )
            # Batch insert new tags
            for doc_id in doc_ids:
                for tid in body.tag_ids:
                    db.add(DocumentTag(document_id=doc_id, tag_id=tid))
        await db.flush()
        return {"action": "set_tags", "processed": len(docs)}

    elif body.action in ("set_searchable", "set_ai_knowledge"):
        field = "searchable" if body.action == "set_searchable" else "ai_knowledge"
        new_val = body.searchable if field == "searchable" else body.ai_knowledge
        if new_val is None:
            raise HTTPException(status_code=400, detail=f"{field} required")
        docs = await _accessible_docs()
        for doc in docs:
            setattr(doc, field, new_val)
        await db.flush()
        return {"action": body.action, "processed": len(docs)}

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
    doc.updated_at = func.now()

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
