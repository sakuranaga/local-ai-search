"""Generate preview images for office documents using LibreOffice headless.

Converts pptx/xlsx/xls/docx/doc → PDF → PNG (one per page/slide/sheet).
Images are stored at {STORAGE_ROOT}/previews/{document_id}/page_NNNN.png.
"""

import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from pathlib import Path

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

PREVIEW_ELIGIBLE = {"pptx", "docx", "doc", "rtf"}
STORAGE_ROOT = os.environ.get("STORAGE_ROOT", "/data/storage")
PREVIEW_DIR = os.path.join(STORAGE_ROOT, "previews")
PREVIEW_DPI = 150
SOFFICE_TIMEOUT = 120  # seconds

# Serialize LibreOffice calls — soffice is not safe for concurrent use
_soffice_lock = asyncio.Lock()


async def generate_preview_images(
    document_id: str, storage_path: str, file_type: str,
) -> int:
    """Convert an office document to preview PNG images.

    Returns the number of pages generated.
    """
    ft = file_type.lower().lstrip(".")
    if ft not in PREVIEW_ELIGIBLE:
        return 0

    if not os.path.exists(storage_path):
        raise FileNotFoundError(f"Source file not found: {storage_path}")

    out_dir = os.path.join(PREVIEW_DIR, document_id)
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        # LibreOffice needs a file extension — create a symlink
        ext = ft if ft != "doc" else "doc"
        symlink_name = f"{uuid.uuid4().hex}.{ext}"
        symlink_path = os.path.join(tmpdir, symlink_name)
        os.symlink(storage_path, symlink_path)

        # Use a unique UserInstallation per process to avoid profile lock conflicts
        user_inst = f"file://{tmpdir}/lo_profile"

        # Convert to PDF via LibreOffice
        async with _soffice_lock:
            proc = await asyncio.create_subprocess_exec(
                "soffice", "--headless", "--norestore",
                f"-env:UserInstallation={user_inst}",
                "--convert-to", "pdf",
                "--outdir", tmpdir,
                symlink_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=SOFFICE_TIMEOUT,
                )
            except asyncio.TimeoutError:
                proc.kill()
                raise TimeoutError(f"LibreOffice conversion timed out after {SOFFICE_TIMEOUT}s")

        if proc.returncode != 0:
            raise RuntimeError(
                f"LibreOffice failed (rc={proc.returncode}): {stderr.decode(errors='replace')[:500]}"
            )

        # Find the generated PDF
        pdf_name = symlink_name.rsplit(".", 1)[0] + ".pdf"
        pdf_path = os.path.join(tmpdir, pdf_name)
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"LibreOffice did not produce PDF: {pdf_name}")

        # Render PDF pages to PNG using PyMuPDF
        doc = fitz.open(pdf_path)
        page_count = len(doc)
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=PREVIEW_DPI)
            pix.save(os.path.join(out_dir, f"page_{i:04d}.png"))
        doc.close()

    logger.info(f"Generated {page_count} preview images for document {document_id}")
    return page_count


def get_preview_images(document_id: str) -> list[str] | None:
    """Return sorted list of preview PNG paths, or None if not available."""
    out_dir = os.path.join(PREVIEW_DIR, document_id)
    if not os.path.isdir(out_dir):
        return None
    images = sorted(
        str(p) for p in Path(out_dir).glob("page_*.png")
    )
    return images if images else None


def delete_preview_images(document_id: str) -> None:
    """Remove all preview images for a document."""
    out_dir = os.path.join(PREVIEW_DIR, document_id)
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir, ignore_errors=True)
