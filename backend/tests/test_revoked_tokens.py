"""A token revoked by logging out is refused by the download's ?token= and by the tus upload (as get_current_user)."""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.routers import documents, ingest

USER_ID = str(uuid.uuid4())


class FakeRedis:
    def __init__(self, revoked=(), fail=False):
        self.revoked, self.fail = set(revoked), fail

    async def exists(self, key):
        if self.fail:
            raise ConnectionError("redis down")
        return int(key in {f"blacklist:{j}" for j in self.revoked})


def fake_db():
    user = MagicMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    return db, user


def with_redis(monkeypatch, module, r):
    async def get_redis():
        return r
    monkeypatch.setattr(module, "get_redis", get_redis, raising=False)


@pytest.fixture(autouse=True)
def token_payload(monkeypatch):
    payload = {"sub": USER_ID, "jti": "j1", "type": "access"}
    monkeypatch.setattr("app.services.auth.verify_token", lambda t, expected_type=None: payload)
    monkeypatch.setattr(ingest, "verify_token", lambda t, expected_type=None: payload)
    return payload


def request():
    req = MagicMock()
    req.headers = {}
    return req


def test_download_token_revoked(monkeypatch):
    with_redis(monkeypatch, documents, FakeRedis(revoked={"j1"}))
    db, _ = fake_db()
    with pytest.raises(HTTPException) as e:
        asyncio.run(documents._resolve_token_user(request(), "a.b.c", db))
    assert e.value.status_code == 401 and "revoked" in e.value.detail


def test_download_token_not_revoked(monkeypatch):
    with_redis(monkeypatch, documents, FakeRedis())
    db, user = fake_db()
    assert asyncio.run(documents._resolve_token_user(request(), "a.b.c", db)) is user


def test_tus_token_revoked(monkeypatch):
    with_redis(monkeypatch, ingest, FakeRedis(revoked={"j1"}))
    db, _ = fake_db()
    assert asyncio.run(ingest._authenticate_tus_upload({"token": "a.b.c"}, db)) == (None, None)


def test_tus_token_not_revoked(monkeypatch):
    with_redis(monkeypatch, ingest, FakeRedis())
    db, user = fake_db()
    assert asyncio.run(ingest._authenticate_tus_upload({"token": "a.b.c"}, db)) == (user, None)


def test_tus_refused_when_redis_cannot_tell(monkeypatch):
    with_redis(monkeypatch, ingest, FakeRedis(fail=True))
    db, _ = fake_db()
    assert asyncio.run(ingest._authenticate_tus_upload({"token": "a.b.c"}, db)) == (None, None)
