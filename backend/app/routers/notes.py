"""Note endpoints – CRUD, tree, move, convert, export."""

import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.deps import get_current_user, require_permission
from app.models import Chunk, Document, File, Folder, User
from app.services.audit import audit_log
from app.services.document_processing import chunk_text, get_embeddings
from app.services.versioning import create_initial_version, create_versions_on_edit, save_new_version

router = APIRouter(prefix="/notes", tags=["notes"])


# ── Schemas ──────────────────────────────────────────────────────────

class NoteCreateRequest(BaseModel):
    parent_note_id: str | None = None


class NoteUpdateRequest(BaseModel):
    title: str | None = None
    note_content: list | dict | None = None  # BlockNote JSON


class NoteMoveRequest(BaseModel):
    parent_note_id: str | None = None  # None = top-level
    note_order: int | None = None
    position: int | None = None  # Insert before this index among siblings (0-based)


class NoteToNoteRequest(BaseModel):
    parent_note_id: str | None = None


class NoteTreeItem(BaseModel):
    id: str
    title: str
    parent_note_id: str | None
    note_order: int
    file_type: str
    note_readonly: bool = False
    updated_at: datetime
    children: list["NoteTreeItem"] = []

    model_config = {"from_attributes": True}


class NoteDetail(BaseModel):
    id: str
    title: str
    note_content: list | dict | None
    parent_note_id: str | None
    note_order: int
    file_type: str
    is_note: bool
    note_readonly: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Helpers ──────────────────────────────────────────────────────────

def _blocknote_to_markdown(blocks: list | dict | None) -> str:
    """Convert BlockNote JSON blocks to Markdown text."""
    if not blocks:
        return ""
    if isinstance(blocks, dict):
        blocks = blocks.get("content", blocks.get("blocks", []))
    if not isinstance(blocks, list):
        return ""

    lines: list[str] = []
    for block in blocks:
        btype = block.get("type", "paragraph")
        content_parts = block.get("content", [])
        text = _extract_inline_text(content_parts)

        if btype == "heading":
            level = block.get("props", {}).get("level", 1)
            lines.append(f"{'#' * level} {text}")
        elif btype == "bulletListItem":
            lines.append(f"- {text}")
        elif btype == "numberedListItem":
            lines.append(f"1. {text}")
        elif btype == "checkListItem":
            checked = block.get("props", {}).get("checked", False)
            lines.append(f"- [{'x' if checked else ' '}] {text}")
        elif btype == "codeBlock":
            lang = block.get("props", {}).get("language", "")
            lines.append(f"```{lang}")
            lines.append(text)
            lines.append("```")
        elif btype == "quote":
            for line in text.split("\n"):
                lines.append(f"> {line}")
        elif btype == "table":
            rows = block.get("content", {}).get("rows", [])
            for row in rows:
                cells = row.get("cells", [])
                cell_texts = [_extract_inline_text(c) for c in cells]
                lines.append("| " + " | ".join(cell_texts) + " |")
        else:
            # paragraph, image, etc.
            if text:
                lines.append(text)

        # Handle nested children (sub-blocks)
        children = block.get("children", [])
        if children:
            child_md = _blocknote_to_markdown(children)
            if child_md:
                # Indent children
                for cline in child_md.split("\n"):
                    lines.append(f"  {cline}")

        lines.append("")  # blank line between blocks

    return "\n".join(lines).strip()


def _extract_inline_text(content_parts) -> str:
    """Extract plain text from BlockNote inline content array."""
    if not content_parts:
        return ""
    if isinstance(content_parts, str):
        return content_parts
    if not isinstance(content_parts, list):
        return ""
    parts = []
    for part in content_parts:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict):
            parts.append(part.get("text", ""))
    return "".join(parts)


def _make_block(block_type: str, text: str, props: dict | None = None) -> dict:
    """Create a BlockNote-compatible block with id, type, props, content, children."""
    block: dict = {
        "id": str(uuid.uuid4())[:8],
        "type": block_type,
        "props": props or {},
        "content": [{"type": "text", "text": text, "styles": {}}] if text else [],
        "children": [],
    }
    return block


def _text_to_blocknote(text: str) -> list[dict]:
    """Convert plain/markdown text to BlockNote JSON blocks."""
    if not text or not text.strip():
        return [_make_block("paragraph", "")]
    blocks = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            blocks.append(_make_block("paragraph", ""))
            i += 1
            continue

        # Headings
        if stripped.startswith("### "):
            blocks.append(_make_block("heading", stripped[4:], {"level": 3}))
        elif stripped.startswith("## "):
            blocks.append(_make_block("heading", stripped[3:], {"level": 2}))
        elif stripped.startswith("# "):
            blocks.append(_make_block("heading", stripped[2:], {"level": 1}))
        # Code blocks
        elif stripped.startswith("```"):
            lang = stripped[3:].strip()
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            blocks.append(_make_block("codeBlock", "\n".join(code_lines), {"language": lang}))
        # Checklist
        elif stripped.startswith("- [x] ") or stripped.startswith("- [ ] "):
            checked = stripped.startswith("- [x]")
            blocks.append(_make_block("checkListItem", stripped[6:], {"checked": checked}))
        # Bullet list
        elif stripped.startswith("- ") or stripped.startswith("* "):
            blocks.append(_make_block("bulletListItem", stripped[2:]))
        # Numbered list
        elif len(stripped) > 2 and stripped[0].isdigit() and ". " in stripped[:5]:
            idx = stripped.index(". ")
            blocks.append(_make_block("numberedListItem", stripped[idx + 2:]))
        # Quote
        elif stripped.startswith("> "):
            blocks.append(_make_block("quote", stripped[2:]))
        # Paragraph
        else:
            blocks.append(_make_block("paragraph", stripped))
        i += 1
    return blocks if blocks else [_make_block("paragraph", "")]


async def _update_search_index(db: AsyncSession, doc: Document, markdown: str, user_id: uuid.UUID):
    """Update content, re-chunk, re-embed after note save."""
    # Version management
    new_ver = await create_versions_on_edit(db, doc, user_id)

    # Update content
    doc.content = markdown

    # Write back to .md file on disk (notes created as .md only)
    if doc.file_type == "md" and doc.source_path:
        try:
            Path(doc.source_path).write_text(markdown, encoding="utf-8")
            # Update file size
            file_result = await db.execute(
                select(File).where(File.document_id == doc.id)
            )
            file_rec = file_result.scalars().first()
            if file_rec:
                file_rec.file_size = len(markdown.encode("utf-8"))
        except OSError:
            pass
    doc.updated_by_id = user_id
    doc.updated_at = datetime.now(timezone.utc)

    # Re-chunk
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(Chunk).where(Chunk.document_id == doc.id))

    if markdown.strip():
        chunks_text = chunk_text(markdown)
        embeddings = await get_embeddings(chunks_text)
        for idx, (chunk_str, emb) in enumerate(zip(chunks_text, embeddings)):
            db.add(Chunk(
                document_id=doc.id,
                chunk_index=idx,
                content=chunk_str,
                embedding=emb,
            ))

    await save_new_version(db, doc, new_ver, user_id, "note_edit")


# ── CRUD ─────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_note(
    body: NoteCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new note (empty MD file + document record)."""
    # Validate parent
    parent_id = None
    if body.parent_note_id:
        parent_id = uuid.UUID(body.parent_note_id)
        parent = await db.get(Document, parent_id)
        if not parent or not parent.is_note or parent.deleted_at:
            raise HTTPException(404, "親ノートが見つかりません")

    # Get next note_order
    max_order = await db.scalar(
        select(func.coalesce(func.max(Document.note_order), -1))
        .where(Document.is_note.is_(True))
        .where(Document.parent_note_id == parent_id if parent_id else Document.parent_note_id.is_(None))
        .where(Document.deleted_at.is_(None))
    )

    # Create empty MD file
    doc_id = uuid.uuid4()
    storage_dir = Path(settings.STORAGE_PATH) / "uploads" / str(current_user.id)
    storage_dir.mkdir(parents=True, exist_ok=True)
    file_path = storage_dir / f"{doc_id}_note.md"
    file_path.write_text("", encoding="utf-8")

    doc = Document(
        id=doc_id,
        title="無題のノート",
        source_path=str(file_path),
        file_type="md",
        content="",
        owner_id=current_user.id,
        created_by_id=current_user.id,
        updated_by_id=current_user.id,
        is_note=True,
        note_content=[],
        parent_note_id=parent_id,
        note_order=(max_order or 0) + 1,
        others_read=True,
        processing_status="done",
        scan_status="skipped",
        source="note",
    )
    db.add(doc)

    # Add File record
    db.add(File(
        document_id=doc_id,
        filename="note.md",
        file_size=0,
        mime_type="text/markdown",
        storage_path=str(file_path),
    ))

    await db.commit()
    await create_initial_version(db, doc, current_user.id)

    return {
        "id": str(doc.id),
        "title": doc.title,
        "parent_note_id": str(doc.parent_note_id) if doc.parent_note_id else None,
        "note_order": doc.note_order,
    }


@router.get("")
async def list_notes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get note tree (hierarchical)."""
    result = await db.execute(
        select(
            Document.id,
            Document.title,
            Document.parent_note_id,
            Document.note_order,
            Document.file_type,
            Document.note_readonly,
            Document.updated_at,
        )
        .where(Document.is_note.is_(True))
        .where(Document.deleted_at.is_(None))
        .order_by(Document.note_order, Document.title)
    )
    rows = result.all()

    # Build tree
    nodes = {}
    for row in rows:
        nodes[row.id] = {
            "id": str(row.id),
            "title": row.title,
            "parent_note_id": str(row.parent_note_id) if row.parent_note_id else None,
            "note_order": row.note_order,
            "file_type": row.file_type,
            "note_readonly": row.note_readonly or False,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "children": [],
        }

    roots = []
    for node in nodes.values():
        pid = node["parent_note_id"]
        if pid and uuid.UUID(pid) in nodes:
            nodes[uuid.UUID(pid)]["children"].append(node)
        else:
            roots.append(node)

    return roots


@router.get("/{note_id}")
async def get_note(
    note_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single note with content."""
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    # Resolve updated_by name
    updated_by_name = None
    if doc.updated_by_id:
        ub = await db.get(User, doc.updated_by_id)
        if ub:
            updated_by_name = ub.display_name or ub.username

    # Resolve folder path
    folder_path = ""
    if doc.folder_id:
        folder = await db.get(Folder, doc.folder_id)
        if folder:
            parts = [folder.name]
            parent = folder.parent_id
            while parent:
                pf = await db.get(Folder, parent)
                if not pf:
                    break
                parts.append(pf.name)
                parent = pf.parent_id
            folder_path = "/".join(reversed(parts))

    return {
        "id": str(doc.id),
        "title": doc.title,
        "note_content": doc.note_content,
        "content": doc.content,
        "parent_note_id": str(doc.parent_note_id) if doc.parent_note_id else None,
        "note_order": doc.note_order,
        "file_type": doc.file_type,
        "is_note": doc.is_note,
        "note_readonly": doc.note_readonly or False,
        "current_version": doc.current_version,
        "updated_by_name": updated_by_name,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "folder_path": folder_path,
    }


@router.patch("/{note_id}")
async def update_note(
    note_id: uuid.UUID,
    body: NoteUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update note content and/or title. Converts to MD for search index."""
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    changed = False

    if body.title is not None:
        doc.title = body.title
        # Sync filename: keep original extension, update base name
        file_result = await db.execute(
            select(File).where(File.document_id == doc.id)
        )
        file_rec = file_result.scalars().first()
        if file_rec:
            ext = Path(file_rec.filename).suffix or ".md"
            file_rec.filename = f"{body.title}{ext}"
        changed = True

    if body.note_content is not None:
        doc.note_content = body.note_content
        markdown = _blocknote_to_markdown(body.note_content)
        await _update_search_index(db, doc, markdown, current_user.id)
        changed = True

    if changed:
        doc.updated_at = datetime.now(timezone.utc)
        await db.commit()

    return {"id": str(doc.id), "title": doc.title, "updated_at": doc.updated_at.isoformat()}


@router.patch("/{note_id}/move")
async def move_note(
    note_id: uuid.UUID,
    body: NoteMoveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Move note in the tree (change parent and/or order).

    When `position` is given, reindex all siblings under the target parent
    so that the moved note lands at the specified index (0-based).
    """
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    # Resolve target parent
    new_parent_id = doc.parent_note_id  # default: unchanged
    if body.parent_note_id is not None:
        if body.parent_note_id == "":
            new_parent_id = None
        else:
            new_parent_id = uuid.UUID(body.parent_note_id)
            if new_parent_id == note_id:
                raise HTTPException(400, "自分自身を親にはできません")
            parent = await db.get(Document, new_parent_id)
            if not parent or not parent.is_note or parent.deleted_at:
                raise HTTPException(404, "親ノートが見つかりません")
            # Check for circular: walk up the tree
            check_id = parent.parent_note_id
            while check_id:
                if check_id == note_id:
                    raise HTTPException(400, "循環参照になります")
                check_doc = await db.get(Document, check_id)
                check_id = check_doc.parent_note_id if check_doc else None

    doc.parent_note_id = new_parent_id

    if body.position is not None:
        # Fetch all siblings under target parent (excluding the moved note)
        sibling_q = (
            select(Document)
            .where(Document.is_note.is_(True))
            .where(Document.deleted_at.is_(None))
            .where(Document.id != note_id)
        )
        if new_parent_id is None:
            sibling_q = sibling_q.where(Document.parent_note_id.is_(None))
        else:
            sibling_q = sibling_q.where(Document.parent_note_id == new_parent_id)
        sibling_q = sibling_q.order_by(Document.note_order, Document.title)

        result = await db.execute(sibling_q)
        siblings = list(result.scalars().all())

        # Insert at position
        pos = max(0, min(body.position, len(siblings)))
        siblings.insert(pos, doc)

        # Reindex all
        for idx, sib in enumerate(siblings):
            sib.note_order = idx
    elif body.note_order is not None:
        doc.note_order = body.note_order

    await db.commit()
    return {"id": str(doc.id), "parent_note_id": str(doc.parent_note_id) if doc.parent_note_id else None, "note_order": doc.note_order}


@router.post("/{note_id}/remove")
async def remove_note(
    note_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove note flag (ノート解除). File remains, note content cleared."""
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    # Move children to top-level
    await db.execute(
        update(Document)
        .where(Document.parent_note_id == note_id)
        .where(Document.is_note.is_(True))
        .values(parent_note_id=None)
    )

    doc.is_note = False
    doc.note_content = None
    doc.parent_note_id = None
    doc.note_order = 0
    await db.commit()
    return {"status": "ok"}


@router.post("/{note_id}/delete-with-file")
async def delete_note_with_file(
    note_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete note AND send file to trash."""
    doc = await db.get(Document, note_id)
    if not doc or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    # Move children to top-level
    await db.execute(
        update(Document)
        .where(Document.parent_note_id == note_id)
        .where(Document.is_note.is_(True))
        .values(parent_note_id=None)
    )

    doc.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok"}


# ── Convert existing file to note ────────────────────────────────────

@router.post("/from-document/{document_id}")
async def convert_to_note(
    document_id: uuid.UUID,
    body: NoteToNoteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Convert existing file to a note. Converts search text to BlockNote JSON."""
    doc = await db.get(Document, document_id)
    if not doc or doc.deleted_at:
        raise HTTPException(404, "ドキュメントが見つかりません")
    if doc.is_note:
        raise HTTPException(400, "既にノートです")
    if doc.file_type != "md":
        raise HTTPException(400, "Markdownファイルのみノートに変換できます")

    # Validate parent
    parent_id = None
    if body.parent_note_id:
        parent_id = uuid.UUID(body.parent_note_id)
        parent = await db.get(Document, parent_id)
        if not parent or not parent.is_note or parent.deleted_at:
            raise HTTPException(404, "親ノートが見つかりません")

    # Get next order
    max_order = await db.scalar(
        select(func.coalesce(func.max(Document.note_order), -1))
        .where(Document.is_note.is_(True))
        .where(Document.parent_note_id == parent_id if parent_id else Document.parent_note_id.is_(None))
        .where(Document.deleted_at.is_(None))
    )

    # Convert existing content to BlockNote JSON
    note_blocks = _text_to_blocknote(doc.content or "")

    doc.is_note = True
    doc.note_content = note_blocks
    doc.parent_note_id = parent_id
    doc.note_order = (max_order or 0) + 1
    await db.commit()

    return {
        "id": str(doc.id),
        "title": doc.title,
        "is_note": True,
        "parent_note_id": str(doc.parent_note_id) if doc.parent_note_id else None,
    }


# ── Export ────────────────────────────────────────────────────────────

@router.post("/{note_id}/export-md")
async def export_note_md(
    note_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Export note as Markdown text."""
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")

    markdown = _blocknote_to_markdown(doc.note_content)
    return {"markdown": markdown, "title": doc.title}


# ── Admin ─────────────────────────────────────────────────────────────

class BulkNoteDeleteRequest(BaseModel):
    note_ids: list[str]


@router.get("/admin/list")
async def admin_list_notes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    """List all notes (flat, for admin management)."""
    result = await db.execute(
        select(
            Document.id,
            Document.title,
            Document.parent_note_id,
            Document.note_order,
            Document.file_type,
            Document.note_readonly,
            Document.created_at,
            Document.updated_at,
        )
        .where(Document.is_note.is_(True))
        .where(Document.deleted_at.is_(None))
        .order_by(Document.updated_at.desc())
    )
    rows = result.all()
    return [
        {
            "id": str(r.id),
            "title": r.title,
            "parent_note_id": str(r.parent_note_id) if r.parent_note_id else None,
            "note_order": r.note_order,
            "file_type": r.file_type,
            "note_readonly": r.note_readonly or False,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]


class NoteReadonlyToggle(BaseModel):
    note_readonly: bool


@router.patch("/admin/{note_id}/readonly")
async def admin_toggle_readonly(
    note_id: uuid.UUID,
    body: NoteReadonlyToggle,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    """Toggle note_readonly flag (admin only)."""
    doc = await db.get(Document, note_id)
    if not doc or not doc.is_note or doc.deleted_at:
        raise HTTPException(404, "ノートが見つかりません")
    doc.note_readonly = body.note_readonly
    await audit_log(db, user=current_user, action="note.readonly_toggle", target_type="note",
                    target_id=str(note_id), target_name=doc.title,
                    detail={"note_readonly": body.note_readonly}, request=request)
    await db.commit()
    return {"id": str(doc.id), "note_readonly": doc.note_readonly}


@router.post("/admin/bulk-delete")
async def admin_bulk_delete_notes(
    body: BulkNoteDeleteRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    """Bulk soft-delete notes (admin only)."""
    now = datetime.now(timezone.utc)
    deleted = 0
    deleted_titles = []
    for nid in body.note_ids:
        doc = await db.get(Document, uuid.UUID(nid))
        if doc and doc.is_note and not doc.deleted_at:
            # Move children to top-level
            await db.execute(
                update(Document)
                .where(Document.parent_note_id == doc.id)
                .where(Document.is_note.is_(True))
                .values(parent_note_id=None)
            )
            doc.deleted_at = now
            deleted += 1
            deleted_titles.append({"id": nid, "title": doc.title})
    if deleted:
        await audit_log(db, user=current_user, action="note.bulk_delete", target_type="note",
                        detail={"count": deleted, "notes": deleted_titles}, request=request)
    await db.commit()
    return {"deleted": deleted}
