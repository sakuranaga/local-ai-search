"""Backfill script to generate preview images for existing documents."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select
from app.db import async_session
from app.models import Document, File
from app.services.preview_generator import (
    PREVIEW_ELIGIBLE,
    generate_preview_images,
    get_preview_images,
)


async def main():
    async with async_session() as db:
        result = await db.execute(
            select(Document.id, Document.title, Document.file_type, File.storage_path)
            .join(File, File.document_id == Document.id)
            .where(Document.deleted_at.is_(None))
            .where(Document.file_type.in_(PREVIEW_ELIGIBLE))
            .order_by(Document.updated_at.desc())
        )
        rows = result.all()

    total = len(rows)
    print(f"Eligible documents: {total}")

    success = 0
    skipped = 0
    failed = 0

    for i, row in enumerate(rows, 1):
        doc_id = str(row.id)
        if get_preview_images(doc_id):
            skipped += 1
            print(f"  [{i}/{total}] SKIP (exists) {row.title}")
            continue
        try:
            count = await generate_preview_images(doc_id, row.storage_path, row.file_type)
            success += 1
            print(f"  [{i}/{total}] OK {row.title}: {count} pages")
        except Exception as e:
            failed += 1
            print(f"  [{i}/{total}] ERROR {row.title}: {e}")

    print(f"\nDone: {success} generated, {skipped} skipped, {failed} failed out of {total}")


if __name__ == "__main__":
    asyncio.run(main())
