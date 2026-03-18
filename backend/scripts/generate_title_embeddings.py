"""One-off script to generate title embeddings for all documents missing them."""

import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select, func
from app.db import async_session
from app.models import Document
from app.services.embedding import get_embedding


async def main():
    async with async_session() as db:
        count = await db.scalar(
            select(func.count())
            .select_from(Document)
            .where(Document.deleted_at.is_(None))
            .where(Document.title_embedding.is_(None))
        )
        print(f"Documents needing title embeddings: {count}")

        result = await db.execute(
            select(Document)
            .where(Document.deleted_at.is_(None))
            .where(Document.title_embedding.is_(None))
            .order_by(Document.updated_at.desc())
        )
        docs = result.scalars().all()

        success = 0
        failed = 0

        for i, doc in enumerate(docs, 1):
            try:
                parts = [doc.title]
                if doc.source_path and doc.source_path != doc.title:
                    parts.append(doc.source_path)
                title_text = " | ".join(parts)

                emb = await get_embedding(title_text)
                doc.title_embedding = emb
                await db.commit()
                success += 1
                print(f"  [{i}/{count}] OK {doc.title}")
            except Exception as e:
                failed += 1
                print(f"  [{i}/{count}] ERROR {doc.title}: {e}")
                await db.rollback()

        print(f"\nDone: {success} succeeded, {failed} failed out of {count}")


if __name__ == "__main__":
    asyncio.run(main())
