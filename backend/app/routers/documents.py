import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.db import get_db
from app.deps import get_current_user
from app.models import Chunk, Document, DocumentPermission, DocumentTag, File, Folder, Tag, User
from app.services.embedding import get_embeddings
from app.services.parser import chunk_text, parse_file

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
    source_path: str | None
    file_type: str
    is_public: bool
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
    memo: str | None = None
    is_public: bool | None = None
    searchable: bool | None = None
    ai_knowledge: bool | None = None
    folder_id: str | None = None  # UUID string or "" to unset
    tag_ids: list[int] | None = None  # replace all tags


class BulkDeleteRequest(BaseModel):
    ids: list[str]


class BulkActionRequest(BaseModel):
    ids: list[str]
    action: str  # "delete" | "reindex" | "set_permissions" | "move_to_folder" | "add_tags" | "remove_tags"
    # For set_permissions action
    permissions: list["PermissionEntry"] | None = None
    # For move_to_folder action
    folder_id: str | None = None  # "" to unset
    # For add_tags / remove_tags actions
    tag_ids: list[int] | None = None


class PermissionEntry(BaseModel):
    user_id: str
    username: str | None = None
    can_read: bool = True
    can_write: bool = False


class PermissionsRequest(BaseModel):
    permissions: list[PermissionEntry]


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
    }
    return type_map.get(ext, "md")


def _is_admin(user: User) -> bool:
    for ur in user.roles:
        if ur.role.permissions and "admin" in [
            p.strip() for p in ur.role.permissions.split(",")
        ]:
            return True
    return False


async def _check_doc_access(
    doc: Document, user: User, need_write: bool = False, db: AsyncSession | None = None
) -> bool:
    """Return True if *user* may access *doc*.

    - admin always has access
    - owner always has access
    - is_public grants read access (not write)
    - DocumentPermission for specific user
    """
    if _is_admin(user):
        return True
    if doc.owner_id == user.id:
        return True

    if not need_write and doc.is_public:
        return True

    if db is not None:
        result = await db.execute(
            select(DocumentPermission).where(
                DocumentPermission.document_id == doc.id,
                DocumentPermission.user_id == user.id,
            )
        )
        perm = result.scalar_one_or_none()
        if perm is not None:
            if need_write:
                return perm.can_write
            return perm.can_read

    return False


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

    # Subquery for chunk count
    chunk_count_sq = (
        select(
            Chunk.document_id,
            func.count(Chunk.id).label("chunk_count"),
        )
        .group_by(Chunk.document_id)
        .subquery()
    )

    # Subquery: document IDs the user has explicit read permission on
    perm_sq = (
        select(DocumentPermission.document_id)
        .where(
            DocumentPermission.user_id == current_user.id,
            DocumentPermission.can_read.is_(True),
        )
        .subquery()
    )

    # Visibility filter
    is_admin = _is_admin(current_user)
    if is_admin:
        visibility_filter = True  # admin sees everything
    else:
        visibility_filter = or_(
            Document.is_public.is_(True),
            Document.owner_id == current_user.id,
            Document.id.in_(select(perm_sq.c.document_id)),
        )

    # Base query
    base = (
        select(
            Document.id,
            Document.title,
            Document.source_path,
            Document.file_type,
            Document.is_public,
            Document.searchable,
            Document.ai_knowledge,
            Document.memo,
            Document.folder_id,
            Folder.name.label("folder_name"),
            Document.created_at,
            Document.updated_at,
            func.coalesce(chunk_count_sq.c.chunk_count, 0).label("chunk_count"),
            CreatedByUser.username.label("created_by_name"),
            UpdatedByUser.username.label("updated_by_name"),
        )
        .outerjoin(chunk_count_sq, Document.id == chunk_count_sq.c.document_id)
        .outerjoin(CreatedByUser, Document.created_by_id == CreatedByUser.id)
        .outerjoin(UpdatedByUser, Document.updated_by_id == UpdatedByUser.id)
        .outerjoin(Folder, Document.folder_id == Folder.id)
        .where(visibility_filter)
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
        DocumentListItem(
            id=str(row.id),
            title=row.title,
            source_path=row.source_path,
            file_type=row.file_type,
            is_public=row.is_public,
            searchable=row.searchable,
            ai_knowledge=row.ai_knowledge,
            chunk_count=row.chunk_count,
            memo=row.memo,
            folder_id=str(row.folder_id) if row.folder_id else None,
            folder_name=row.folder_name,
            tags=tags_map.get(row.id, []),
            created_by_name=row.created_by_name,
            updated_by_name=row.updated_by_name,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]

    return DocumentListResponse(items=items, total=total, page=page, per_page=per_page)


# ---------------------------------------------------------------------------
# 2. POST /documents/upload
# ---------------------------------------------------------------------------


@router.post("/upload", response_model=DocumentListItem, status_code=status.HTTP_201_CREATED)
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
        storage_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {e}")

    # Create the document record
    doc = Document(
        title=file.filename,
        source_path=str(storage_path),
        file_type=file_type,
        content=text_content,
        owner_id=current_user.id,
        is_public=True,
        created_by_id=current_user.id,
        updated_by_id=current_user.id,
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

    return DocumentListItem(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        is_public=doc.is_public,
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        chunk_count=len(chunks_text),
        memo=doc.memo,
        created_by_name=current_user.username,
        updated_by_name=current_user.username,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


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
    result = await db.execute(select(Document).where(Document.id == document_id))
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

    return DocumentDetail(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        is_public=doc.is_public,
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
# 4. PATCH /documents/{id} — update title, memo, is_public
# ---------------------------------------------------------------------------


@router.patch("/{document_id}", response_model=DocumentListItem)
async def update_document(
    document_id: uuid.UUID,
    body: DocumentUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update document metadata. Requires ownership, write permission, or admin."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    if body.title is not None:
        doc.title = body.title
    if body.memo is not None:
        doc.memo = body.memo
    if body.is_public is not None:
        doc.is_public = body.is_public
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

    return DocumentListItem(
        id=str(doc.id),
        title=doc.title,
        source_path=doc.source_path,
        file_type=doc.file_type,
        is_public=doc.is_public,
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
    """Delete a document and its associated chunks and files."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=True, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    # Delete associated files from disk
    files_result = await db.execute(select(File).where(File.document_id == doc.id))
    for f in files_result.scalars().all():
        try:
            Path(f.storage_path).unlink(missing_ok=True)
        except OSError:
            pass

    await db.delete(doc)


# ---------------------------------------------------------------------------
# 6. POST /documents/bulk-delete
# ---------------------------------------------------------------------------


@router.post("/bulk-delete")
async def bulk_delete_documents(
    body: BulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete multiple documents. Returns count of successfully deleted docs."""
    deleted = 0

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

        # Delete associated files from disk
        files_result = await db.execute(select(File).where(File.document_id == doc.id))
        for f in files_result.scalars().all():
            try:
                Path(f.storage_path).unlink(missing_ok=True)
            except OSError:
                pass

        await db.delete(doc)
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
            files_result = await db.execute(select(File).where(File.document_id == doc.id))
            for f in files_result.scalars().all():
                try:
                    Path(f.storage_path).unlink(missing_ok=True)
                except OSError:
                    pass
            await db.delete(doc)
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
        if body.permissions is None:
            raise HTTPException(status_code=400, detail="permissions required for set_permissions action")
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
            if doc.owner_id != current_user.id and not _is_admin(current_user):
                continue
            await db.execute(
                delete(DocumentPermission).where(DocumentPermission.document_id == doc.id)
            )
            for entry in body.permissions:
                try:
                    uid = uuid.UUID(entry.user_id)
                except ValueError:
                    continue
                db.add(DocumentPermission(
                    document_id=doc.id,
                    user_id=uid,
                    can_read=entry.can_read,
                    can_write=entry.can_write,
                ))
            processed += 1
        await db.flush()
        return {"action": "set_permissions", "processed": processed}

    elif body.action == "move_to_folder":
        folder_uuid = uuid.UUID(body.folder_id) if body.folder_id else None
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
            doc.folder_id = folder_uuid
            doc.updated_by_id = current_user.id
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

    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")


# ---------------------------------------------------------------------------
# 7. GET /documents/{id}/permissions
# ---------------------------------------------------------------------------


@router.get("/{document_id}/permissions", response_model=list[PermissionEntry])
async def get_document_permissions(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return list of permission entries for the document."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if not await _check_doc_access(doc, current_user, need_write=False, db=db):
        raise HTTPException(status_code=403, detail="Access denied")

    perms_result = await db.execute(
        select(DocumentPermission, User.username)
        .join(User, DocumentPermission.user_id == User.id)
        .where(DocumentPermission.document_id == doc.id)
    )
    rows = perms_result.all()

    return [
        PermissionEntry(
            user_id=str(perm.user_id),
            username=username,
            can_read=perm.can_read,
            can_write=perm.can_write,
        )
        for perm, username in rows
    ]


# ---------------------------------------------------------------------------
# 8. PUT /documents/{id}/permissions
# ---------------------------------------------------------------------------


@router.put("/{document_id}/permissions")
async def set_document_permissions(
    document_id: uuid.UUID,
    body: PermissionsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace all permissions for the document. Owner or admin only."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Only owner or admin can manage permissions
    if doc.owner_id != current_user.id and not _is_admin(current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    # Delete existing permissions
    await db.execute(
        delete(DocumentPermission).where(DocumentPermission.document_id == doc.id)
    )

    # Create new permissions
    for entry in body.permissions:
        try:
            uid = uuid.UUID(entry.user_id)
        except ValueError:
            continue
        perm = DocumentPermission(
            document_id=doc.id,
            user_id=uid,
            can_read=entry.can_read,
            can_write=entry.can_write,
        )
        db.add(perm)

    await db.flush()
    return {"status": "ok", "count": len(body.permissions)}


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
        is_public=doc.is_public,
        searchable=doc.searchable,
        ai_knowledge=doc.ai_knowledge,
        chunk_count=len(chunks_text),
        memo=doc.memo,
        created_by_name=None,
        updated_by_name=current_user.username,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )
