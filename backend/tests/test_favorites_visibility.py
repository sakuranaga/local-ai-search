"""Favorites and the tags' counts tell nothing of documents the user may not read: a favorite is added only for a
readable document not in the trash (else 404, as one not there); the list and the counts are filtered."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.routers import favorites, tags
from tests.conftest import make_document, make_user


def db_with(doc):
    db = MagicMock()
    db.get = AsyncMock(return_value=doc)
    found = MagicMock()
    found.scalar_one_or_none.return_value = None
    db.execute = AsyncMock(return_value=found)
    db.commit = AsyncMock()
    return db


@pytest.mark.asyncio
@pytest.mark.parametrize("others_read,deleted,ok", [(True, False, True), (False, False, False), (True, True, False)])
async def test_a_favorite_only_for_a_readable_document_not_trashed(others_read, deleted, ok):
    user = make_user(roles=["user"])
    doc = make_document(others_read=others_read)
    doc.deleted_at = MagicMock() if deleted else None
    db = db_with(doc)
    if ok:
        assert (await favorites.add_favorite(str(doc.id), db=db, current_user=user)) == {"status": "added"}
    else:
        with pytest.raises(HTTPException) as e:
            await favorites.add_favorite(str(doc.id), db=db, current_user=user)
        assert e.value.status_code == 404
        db.add.assert_not_called()


def _sql(db) -> str:
    stmt = db.execute.await_args_list[-1].args[0]
    return str(stmt.compile(dialect=postgresql.dialect()))


@pytest.mark.asyncio
async def test_the_favorites_list_and_the_tags_counts_are_filtered(monkeypatch):
    user = make_user(roles=["user"])

    async def no_groups(db, user_id):
        return []

    monkeypatch.setattr(favorites, "get_user_group_ids", no_groups)
    monkeypatch.setattr(tags, "get_user_group_ids", no_groups)
    for call in (lambda db: favorites.list_favorites(db=db, current_user=user),
                 lambda db: tags.list_tags(db=db, current_user=user)):
        db = MagicMock()
        rows = MagicMock()
        rows.all.return_value = []
        db.execute = AsyncMock(return_value=rows)
        await call(db)
        sql = _sql(db)
        assert "documents.others_read" in sql and "documents.deleted_at IS NULL" in sql
