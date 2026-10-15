"""Start-up schema changes without needless locks (design doc AP).

PostgreSQL takes a table's lock for `ALTER TABLE ... IF NOT EXISTS` (and `CREATE INDEX IF NOT EXISTS`) before it
looks whether there is anything to do. Every worker ran them on every start, several tables in one transaction,
and crossed a job holding the same tables in the other order (deadlock, 2026-10-11). So:

- `ddl` looks at the catalog first and sends a schema change only when it is still needed
- `init_lock` lets one process at a time do the start-up work (an advisory lock)
- `with_retry` tries a stage again on a deadlock or a lock wait running out
- all of it within `BUDGET` seconds (gunicorn stops a worker silent for 300 s)
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

logger = logging.getLogger(__name__)

LOCK_KEY = int.from_bytes(hashlib.sha256(b"las:init_db").digest()[:8], "big", signed=True)
BUDGET = 240.0  # seconds for the whole start-up work
LOCK_TIMEOUT = "10s"  # waiting for a table's lock, each try
RETRY_WAITS = (2.0, 4.0)  # between the three tries
RETRY_MIN_LEFT = 15.0  # no new try with less time left
RETRY_CODES = {"40P01", "55P03"}  # deadlock detected, lock not available

_NAME = r"([A-Za-z_][A-Za-z0-9_]*)"
_ADD = re.compile(rf"^ALTER\s+TABLE\s+{_NAME}\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+{_NAME}\b", re.I)
_INDEX = re.compile(rf"^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+{_NAME}\s+ON\b", re.I)
_DEFAULT = re.compile(rf"^ALTER\s+TABLE\s+{_NAME}\s+ALTER\s+COLUMN\s+{_NAME}\s+SET\s+DEFAULT\b", re.I)
_NOT_NULL = re.compile(rf"^ALTER\s+TABLE\s+{_NAME}\s+ALTER\s+COLUMN\s+{_NAME}\s+SET\s+NOT\s+NULL\s*$", re.I)
_DROP = re.compile(rf"^ALTER\s+TABLE\s+{_NAME}\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+{_NAME}\s*$", re.I)


class Deadline:
    def __init__(self, seconds: float):
        self.end = time.monotonic() + seconds

    def left(self) -> float:
        return self.end - time.monotonic()


def sqlstate(exc: BaseException) -> str | None:
    return getattr(getattr(exc, "orig", None), "sqlstate", None)


async def _column(conn, table: str, column: str):
    return (await conn.execute(text(
        "SELECT column_default, is_nullable FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = :t AND column_name = :c"),
        {"t": table.lower(), "c": column.lower()})).first()


async def ddl(conn, sql: str) -> bool:
    """Runs `sql` unless the catalog says it is done already; True when it ran."""
    s = sql.strip()
    if m := _ADD.match(s):
        needed = await _column(conn, *m.groups()) is None
    elif m := _INDEX.match(s):
        needed = (await conn.execute(text("SELECT to_regclass(:i)"), {"i": m.group(1).lower()})).scalar() is None
    elif m := _DEFAULT.match(s):
        col = await _column(conn, *m.groups())
        needed = col is None or col.column_default is None
    elif m := _NOT_NULL.match(s):
        col = await _column(conn, *m.groups())
        needed = col is None or col.is_nullable == "YES"
    elif m := _DROP.match(s):
        needed = await _column(conn, *m.groups()) is not None
    else:
        needed = True
    if needed:
        await conn.execute(text(sql))
    return needed


@asynccontextmanager
async def init_lock(engine, deadline: Deadline):
    """One process at a time; waits at most what is left of the budget. Yields the lock's connection."""
    conn = await engine.connect()
    try:
        async with conn.begin():  # SET LOCAL ends with it; the session's lock stays
            ms = max(1, int(deadline.left() * 1000))
            await conn.execute(text(f"SET LOCAL lock_timeout = {ms}"))
            await conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
    except BaseException:  # the lock may have been taken before it failed: never back into the pool (code review 1)
        try:
            await conn.invalidate()
        finally:
            await conn.close()
        raise
    try:
        yield conn
    finally:
        let_go = False
        try:
            if conn.in_transaction():
                await conn.rollback()
            async with conn.begin():
                let_go = bool((await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})).scalar())
        except Exception:
            logger.warning("init_db: the start-up lock could not be let go", exc_info=True)
        if not let_go:  # the lock sits on the session: never back into the pool
            await conn.invalidate()
        await conn.close()


# (table, column, sequence) of the unix ids
UNIX_ID_SEQUENCES = (("users", "unix_uid", "users_unix_uid_seq"), ("groups", "unix_gid", "groups_unix_gid_seq"))


async def raise_unix_id_sequences(engine, deadline: Deadline | None = None) -> None:
    """Raise each unix id sequence above the largest number in its table (a dump without the sequence, a number
    set by hand); never lowers it. Only then is the table locked: the lock waits for a number being given and holds
    new ones off, so the largest number read is final. A sequence ahead of the table needs no lock, as every number
    being given comes from it. One transaction per table: one lock at a time."""
    for table, column, seq in UNIX_ID_SEQUENCES:
        behind = (f"FROM (SELECT max({column}) AS m FROM {table}) AS t, {seq} AS s "
                  f"WHERE t.m IS NOT NULL AND t.m >= CASE WHEN s.is_called THEN s.last_value + 1 ELSE s.last_value END")

        async def _raise(conn, table=table, seq=seq, behind=behind):
            if (await conn.execute(text(f"SELECT 1 {behind}"))).first() is None:
                return
            await conn.execute(text(f"LOCK TABLE {table} IN SHARE ROW EXCLUSIVE MODE"))
            await conn.execute(text(f"SELECT setval('{seq}', t.m) {behind}"))
        await with_retry(engine, f"{seq} raised", _raise, deadline or Deadline(BUDGET))


async def with_retry(engine, name: str, fn, deadline: Deadline) -> None:
    """Runs `fn(conn)` in a transaction; on a deadlock or a lock wait running out, up to three times."""
    for attempt in range(len(RETRY_WAITS) + 1):
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
                await fn(conn)
            return
        except DBAPIError as e:
            code = sqlstate(e)
            if code not in RETRY_CODES or attempt == len(RETRY_WAITS):
                raise
            wait = RETRY_WAITS[attempt]
            if deadline.left() - wait < RETRY_MIN_LEFT:
                raise
            logger.warning("init_db: %s: %s, trying again (%d)", name, code, attempt + 2)
            await asyncio.sleep(wait)
