"""One-off script to generate AI summaries for all documents missing them."""

import asyncio
import sys
import os

# Ensure the app module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select, func
from app.db import async_session
from app.models import Document
from app.services.llm import generate_summary


async def main():
    async with async_session() as db:
        # Count documents needing summaries
        count = await db.scalar(
            select(func.count())
            .select_from(Document)
            .where(Document.deleted_at.is_(None))
            .where((Document.summary.is_(None)) | (Document.summary == ""))
        )
        print(f"Documents needing summaries: {count}")

        # Fetch all documents without summaries
        result = await db.execute(
            select(Document)
            .where(Document.deleted_at.is_(None))
            .where((Document.summary.is_(None)) | (Document.summary == ""))
            .order_by(Document.updated_at.desc())
        )
        docs = result.scalars().all()

        success = 0
        failed = 0

        for i, doc in enumerate(docs, 1):
            try:
                content = doc.content or ""
                if not content.strip():
                    print(f"  [{i}/{count}] SKIP (empty) {doc.title}")
                    continue

                summary = await generate_summary(content, doc.title)
                if summary:
                    doc.summary = summary
                    await db.commit()
                    success += 1
                    print(f"  [{i}/{count}] OK {doc.title}: {summary[:60]}...")
                else:
                    failed += 1
                    print(f"  [{i}/{count}] EMPTY {doc.title}")
            except Exception as e:
                failed += 1
                print(f"  [{i}/{count}] ERROR {doc.title}: {e}")
                await db.rollback()

        print(f"\nDone: {success} succeeded, {failed} failed out of {count}")


if __name__ == "__main__":
    asyncio.run(main())
