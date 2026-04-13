"""
LAS FUSE Server — Virtual filesystem backed by the LAS database.

Maps LAS Folder/Document hierarchy to a POSIX filesystem that Samba can serve.
Actual file I/O is redirected to the existing UUID-based storage.

Usage:
    python -m app.fuse_server [--mountpoint /mnt/base/fs] [--debug]
"""

import argparse
import errno
import logging
import os
import re
import shutil
import stat
import time
import unicodedata
import uuid as _uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import pyfuse3
import trio

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Sync DB helpers (pyfuse3 uses trio, not asyncio — so we use sync SQLAlchemy)
# ---------------------------------------------------------------------------

from sqlalchemy import select, func as sa_func, create_engine
from sqlalchemy.orm import Session, sessionmaker

_engine = None
_SessionLocal = None


def _init_db():
    global _engine, _SessionLocal
    db_url = os.environ.get("DATABASE_URL", "postgresql+asyncpg://las:las@db:5432/las")
    # Convert asyncpg URL to psycopg2 for sync access
    sync_url = db_url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    _engine = create_engine(sync_url, echo=False, pool_size=5, max_overflow=10)
    _SessionLocal = sessionmaker(_engine, class_=Session, expire_on_commit=False)


def _get_session() -> Session:
    assert _SessionLocal is not None
    return _SessionLocal()


# ---------------------------------------------------------------------------
# NFC normalization
# ---------------------------------------------------------------------------

def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _nfc_bytes(b: bytes) -> bytes:
    return _nfc(b.decode("utf-8", errors="surrogateescape")).encode("utf-8", errors="surrogateescape")


# ---------------------------------------------------------------------------
# Staging helpers
# ---------------------------------------------------------------------------

_STORAGE_PATH = os.environ.get("STORAGE_PATH", "/data/storage")
_STAGING_PATH = os.path.join(_STORAGE_PATH, "smb-staging")

_TEMP_PATTERNS = [
    re.compile(r"^~\$"), re.compile(r"^\.~lock\."), re.compile(r"\.tmp$", re.I),
    re.compile(r"^\.DS_Store$"), re.compile(r"^Thumbs\.db$", re.I),
    re.compile(r"^desktop\.ini$", re.I), re.compile(r"^\._"),
]

_TEMP_DIR_PATTERNS = [
    re.compile(r"\.sb-[0-9a-f]+-"),       # macOS TextEdit sandbox
    re.compile(r"^（.*で保存中の書類）$"),   # Typora
]


def _is_temp_file(name: str) -> bool:
    return any(p.search(name) for p in _TEMP_PATTERNS)


def _is_temp_dir(name: str) -> bool:
    return any(p.search(name) for p in _TEMP_DIR_PATTERNS)


def _get_file_type(filename: str) -> str:
    ext = Path(filename).suffix.lstrip(".").lower()
    return ext if ext else "bin"


def _staging_dir(parent_inode: int) -> str:
    """Staging directory for a given parent inode."""
    key = _inode_key(parent_inode)
    if key and key[0] == "folder":
        d = os.path.join(_STAGING_PATH, key[1])
    else:
        d = os.path.join(_STAGING_PATH, "_root")
    os.makedirs(d, exist_ok=True)
    return d


def _final_storage_path(filename: str) -> str:
    """Permanent UUID-based storage path."""
    file_id = _uuid.uuid4()
    suffix = Path(filename).suffix
    max_name = max(1, 255 - 37 - len(suffix.encode("utf-8")))
    base = Path(filename).stem
    truncated = base.encode("utf-8")[:max_name].decode("utf-8", errors="ignore")
    stored = f"{file_id}_{truncated}{suffix}"
    d = os.path.join(_STORAGE_PATH, "uploads", "smb")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, stored)


@dataclass
class PendingFile:
    """File in staging, not yet synced to DB."""
    inode: int
    name: str
    staging_path: str
    parent_inode: int
    caller_uid: int
    is_temp: bool = False
    closed: bool = False
    deleted: bool = False


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

MAX_CACHED_FOLDERS = 100
CACHE_TTL = 5.0  # seconds


@dataclass
class CachedEntry:
    """Metadata for a single file or folder."""
    inode: int
    name: str  # NFC-normalized
    is_dir: bool
    size: int = 0
    mode: int = 0
    uid: int = 0
    gid: int = 0
    mtime_ns: int = 0
    # For files: path to real storage
    storage_path: str = ""
    # DB IDs
    doc_id: str = ""
    folder_db_id: str = ""
    # Permission check fields
    owner_uid: int = 0
    group_gid: int = 0
    group_read: bool = False
    group_write: bool = False
    others_read: bool = True
    others_write: bool = False
    download_prohibited: bool = False


@dataclass
class FolderCache:
    """Cache for a single folder's children."""
    entries: dict[str, CachedEntry] = field(default_factory=dict)  # name -> entry
    timestamp: float = 0.0

    def is_valid(self) -> bool:
        return (time.monotonic() - self.timestamp) < CACHE_TTL


class MetadataCache:
    """LRU folder-level metadata cache."""

    def __init__(self, max_folders: int = MAX_CACHED_FOLDERS):
        self._folders: OrderedDict[int, FolderCache] = OrderedDict()
        self._max = max_folders

    def get(self, parent_inode: int) -> FolderCache | None:
        fc = self._folders.get(parent_inode)
        if fc is None or not fc.is_valid():
            return None
        self._folders.move_to_end(parent_inode)
        return fc

    def put(self, parent_inode: int, fc: FolderCache):
        self._folders[parent_inode] = fc
        self._folders.move_to_end(parent_inode)
        while len(self._folders) > self._max:
            self._folders.popitem(last=False)

    def invalidate(self, parent_inode: int):
        self._folders.pop(parent_inode, None)

    def clear(self):
        self._folders.clear()


# ---------------------------------------------------------------------------
# Inode management
# ---------------------------------------------------------------------------

ROOT_INODE = pyfuse3.ROOT_INODE  # 1

# We use a simple inode allocator. Inodes are mapped to (type, db_id).
# type: "root", "folder", "doc"

_next_inode = 2
_inode_to_key: dict[int, tuple[str, str]] = {ROOT_INODE: ("root", "")}
_key_to_inode: dict[tuple[str, str], int] = {("root", ""): ROOT_INODE}
_inode_to_parent: dict[int, int] = {}  # child inode -> parent inode (for O(1) cache lookup)


def _get_or_alloc_inode(kind: str, db_id: str, parent_inode: int = 0) -> int:
    global _next_inode
    key = (kind, db_id)
    if key in _key_to_inode:
        ino = _key_to_inode[key]
        if parent_inode:
            _inode_to_parent[ino] = parent_inode
        return ino
    ino = _next_inode
    _next_inode += 1
    _inode_to_key[ino] = key
    _key_to_inode[key] = ino
    if parent_inode:
        _inode_to_parent[ino] = parent_inode
    return ino


def _inode_key(inode: int) -> tuple[str, str] | None:
    return _inode_to_key.get(inode)


# ---------------------------------------------------------------------------
# Permission helpers
# ---------------------------------------------------------------------------

def _compute_mode(is_dir: bool, group_read: bool, group_write: bool,
                  others_read: bool, others_write: bool) -> int:
    if is_dir:
        mode = stat.S_IFDIR | 0o700  # owner always rwx
        if group_read:  mode |= 0o050
        if group_write: mode |= 0o020
        if others_read: mode |= 0o005
        if others_write: mode |= 0o002
    else:
        mode = stat.S_IFREG | 0o600  # owner always rw
        if group_read:  mode |= 0o040
        if group_write: mode |= 0o020
        if others_read: mode |= 0o004
        if others_write: mode |= 0o002
    return mode


# ---------------------------------------------------------------------------
# DB query helpers
# ---------------------------------------------------------------------------

def _load_folder_children_sync(parent_inode: int) -> FolderCache:
    """Load all children (subfolders + documents) of a folder from DB (sync)."""
    from app.models import Folder, Document, File, User, Group

    key = _inode_key(parent_inode)
    if key is None:
        return FolderCache()

    kind, db_id = key
    if kind == "root":
        folder_id = None
    elif kind == "folder":
        folder_id = db_id
    else:
        return FolderCache()

    fc = FolderCache(timestamp=time.monotonic())

    with _get_session() as db:
        # Load subfolders
        if folder_id is None:
            q = select(Folder).where(Folder.parent_id.is_(None))
        else:
            q = select(Folder).where(Folder.parent_id == folder_id)
        folders = db.execute(q).scalars().all()

        for f in folders:
            name = _nfc(f.name)
            ino = _get_or_alloc_inode("folder", str(f.id), parent_inode)
            owner_uid = 0
            owner_gid = 0
            if f.owner_id:
                u = db.get(User, f.owner_id)
                if u and u.unix_uid:
                    owner_uid = u.unix_uid
            if f.group_id:
                g = db.get(Group, f.group_id)
                if g and g.unix_gid:
                    owner_gid = g.unix_gid

            mtime_ns = int(f.updated_at.timestamp() * 1e9) if f.updated_at else int(time.time() * 1e9)
            mode = _compute_mode(True, f.group_read, f.group_write, f.others_read, f.others_write)

            fc.entries[name] = CachedEntry(
                inode=ino, name=name, is_dir=True,
                mode=mode, uid=owner_uid, gid=owner_gid,
                mtime_ns=mtime_ns, folder_db_id=str(f.id),
                owner_uid=owner_uid, group_gid=owner_gid,
                group_read=f.group_read, group_write=f.group_write,
                others_read=f.others_read, others_write=f.others_write,
            )

        # Load documents
        if folder_id is None:
            q = select(Document).where(Document.folder_id.is_(None), Document.deleted_at.is_(None))
        else:
            q = select(Document).where(Document.folder_id == folder_id, Document.deleted_at.is_(None))
        docs = db.execute(q).scalars().all()

        for doc in docs:
            name = _nfc(doc.title or "untitled")
            ino = _get_or_alloc_inode("doc", str(doc.id), parent_inode)
            owner_uid = 0
            owner_gid = 0
            if doc.owner_id:
                u = db.get(User, doc.owner_id)
                if u and u.unix_uid:
                    owner_uid = u.unix_uid
            if doc.group_id:
                g = db.get(Group, doc.group_id)
                if g and g.unix_gid:
                    owner_gid = g.unix_gid

            file_rec = db.execute(
                select(File).where(File.document_id == doc.id).limit(1)
            ).scalar_one_or_none()
            file_size = file_rec.file_size if file_rec else 0
            storage_path = file_rec.storage_path if file_rec else (doc.source_path or "")

            mtime_ns = int(doc.updated_at.timestamp() * 1e9) if doc.updated_at else int(time.time() * 1e9)
            mode = _compute_mode(
                False,
                getattr(doc, "group_read", False),
                getattr(doc, "group_write", False),
                getattr(doc, "others_read", True),
                getattr(doc, "others_write", False),
            )

            doc_group_read = getattr(doc, "group_read", False)
            doc_group_write = getattr(doc, "group_write", False)
            doc_others_read = getattr(doc, "others_read", True)
            doc_others_write = getattr(doc, "others_write", False)
            doc_dl_prohibited = getattr(doc, "download_prohibited", False)

            fc.entries[name] = CachedEntry(
                inode=ino, name=name, is_dir=False,
                size=file_size, mode=mode, uid=owner_uid, gid=owner_gid,
                mtime_ns=mtime_ns, storage_path=storage_path, doc_id=str(doc.id),
                owner_uid=owner_uid, group_gid=owner_gid,
                group_read=doc_group_read, group_write=doc_group_write,
                others_read=doc_others_read, others_write=doc_others_write,
                download_prohibited=doc_dl_prohibited,
            )

    return fc


# Import models after helpers are defined
from app.models import Document, File, Folder, User, Group, GroupMember, Job


# ---------------------------------------------------------------------------
# User visibility helpers
# ---------------------------------------------------------------------------

# Cache: unix_uid -> (is_admin, set of unix_gids the user belongs to)
_user_info_cache: dict[int, tuple[bool, set[int], float]] = {}
_USER_INFO_TTL = 30.0  # seconds


def _get_user_info_sync(unix_uid: int) -> tuple[bool, set[int]]:
    """Get (is_admin, group_gids) for a unix_uid. Cached."""
    cached = _user_info_cache.get(unix_uid)
    if cached and (time.monotonic() - cached[2]) < _USER_INFO_TTL:
        return cached[0], cached[1]

    is_admin = False
    group_gids: set[int] = set()

    with _get_session() as db:
        user = db.execute(select(User).where(User.unix_uid == unix_uid)).scalar_one_or_none()
        if user:
            from app.services.permissions import is_admin as check_admin
            is_admin = check_admin(user)
            memberships = db.execute(
                select(Group.unix_gid).join(GroupMember).where(GroupMember.user_id == user.id)
            ).scalars().all()
            group_gids = {gid for gid in memberships if gid is not None}

    _user_info_cache[unix_uid] = (is_admin, group_gids, time.monotonic())
    return is_admin, group_gids


def _can_write_entry(entry: CachedEntry, caller_uid: int, caller_is_admin: bool,
                     caller_gids: set[int]) -> bool:
    """Check if a user can write to this entry."""
    if caller_is_admin:
        return True
    if entry.owner_uid == caller_uid:
        return True
    if entry.group_write and entry.group_gid in caller_gids:
        return True
    if entry.others_write:
        return True
    return False


def _can_write_folder_sync(folder_id: str | None, caller_uid: int) -> bool:
    """Check if a user can create files in this folder (sync DB check)."""
    is_admin, caller_gids = _get_user_info_sync(caller_uid)
    if is_admin:
        return True
    if folder_id is None:
        return True  # Root folder: allow all authenticated users

    with _get_session() as db:
        folder = db.get(Folder, folder_id)
        if not folder:
            return True
        owner_uid = 0
        if folder.owner_id:
            owner = db.get(User, folder.owner_id)
            if owner and owner.unix_uid:
                owner_uid = owner.unix_uid
        if owner_uid == caller_uid:
            return True
        if folder.group_write:
            group_gid = 0
            if folder.group_id:
                grp = db.get(Group, folder.group_id)
                if grp and grp.unix_gid:
                    group_gid = grp.unix_gid
            if group_gid in caller_gids:
                return True
        if folder.others_write:
            return True
    return False


def _can_see_entry(entry: CachedEntry, caller_uid: int, caller_is_admin: bool,
                   caller_gids: set[int]) -> bool:
    """Check if a user can see this entry in a directory listing."""
    # Hide download-prohibited files from SMB
    if not entry.is_dir and entry.download_prohibited:
        return False
    # Admin sees everything
    if caller_is_admin:
        return True
    # Owner sees their own
    if entry.owner_uid == caller_uid:
        return True
    # Group member with group_read
    if entry.group_read and entry.group_gid in caller_gids:
        return True
    # Others with others_read
    if entry.others_read:
        return True
    return False


# ---------------------------------------------------------------------------
# FUSE Operations
# ---------------------------------------------------------------------------


class LASFuseServer(pyfuse3.Operations):
    """Read-only FUSE filesystem backed by LAS database."""

    def __init__(self):
        super().__init__()
        self._cache = MetadataCache()
        self._open_files: dict[int, dict] = {}  # fh -> {fd, inode, staging_path?, ...}
        self._next_fh = 1
        self._dir_handles: dict[int, tuple[int, int]] = {}
        self._next_dir_fh = 1_000_000
        # Pending map: parent_inode -> {name -> PendingFile}
        self._pending: dict[int, dict[str, PendingFile]] = {}
        # Sync queue: closed pending files ready for DB commit
        self._sync_queue: list[PendingFile] = []
        # Clean up staging remnants from previous crashes
        if os.path.exists(_STAGING_PATH):
            shutil.rmtree(_STAGING_PATH, ignore_errors=True)
        os.makedirs(_STAGING_PATH, exist_ok=True)

    # -- helpers --

    async def _get_folder_cache(self, parent_inode: int) -> FolderCache:
        fc = self._cache.get(parent_inode)
        if fc is not None:
            return fc
        fc = await trio.to_thread.run_sync(_load_folder_children_sync, parent_inode)
        self._cache.put(parent_inode, fc)
        return fc

    async def _find_entry_by_inode(self, inode: int) -> CachedEntry | None:
        """O(1) lookup of a cached entry by inode via parent reverse map."""
        parent_ino = _inode_to_parent.get(inode)
        if parent_ino is None:
            return None
        fc = await self._get_folder_cache(parent_ino)
        for entry in fc.entries.values():
            if entry.inode == inode:
                return entry
        return None

    async def _lookup_entry(self, parent_inode: int, name: str) -> CachedEntry | None:
        fc = await self._get_folder_cache(parent_inode)
        return fc.entries.get(name)

    def _make_attr(self, entry: CachedEntry) -> pyfuse3.EntryAttributes:
        attr = pyfuse3.EntryAttributes()
        attr.st_ino = entry.inode
        attr.generation = 0
        attr.entry_timeout = 5
        attr.attr_timeout = 5
        attr.st_mode = entry.mode
        attr.st_nlink = 2 if entry.is_dir else 1
        attr.st_size = entry.size
        attr.st_uid = entry.uid
        attr.st_gid = entry.gid
        attr.st_atime_ns = entry.mtime_ns
        attr.st_mtime_ns = entry.mtime_ns
        attr.st_ctime_ns = entry.mtime_ns
        return attr

    def _make_root_attr(self) -> pyfuse3.EntryAttributes:
        attr = pyfuse3.EntryAttributes()
        attr.st_ino = ROOT_INODE
        attr.generation = 0
        attr.entry_timeout = 5
        attr.attr_timeout = 5
        attr.st_mode = stat.S_IFDIR | 0o755
        attr.st_nlink = 2
        attr.st_size = 0
        attr.st_uid = 0
        attr.st_gid = 0
        now_ns = int(time.time() * 1e9)
        attr.st_atime_ns = now_ns
        attr.st_mtime_ns = now_ns
        attr.st_ctime_ns = now_ns
        return attr

    # -- FUSE callbacks --

    async def getattr(self, inode: int, ctx=None):
        if inode == ROOT_INODE:
            return self._make_root_attr()
        key = _inode_key(inode)
        if key is None:
            raise pyfuse3.FUSEError(errno.ENOENT)

        # O(1) lookup via parent inode reverse map
        parent_ino = _inode_to_parent.get(inode)
        if parent_ino is not None:
            fc = self._cache.get(parent_ino)
            if fc is not None:
                for entry in fc.entries.values():
                    if entry.inode == inode:
                        return self._make_attr(entry)
            # Cache miss — reload parent folder
            fc = await self._get_folder_cache(parent_ino)
            for entry in fc.entries.values():
                if entry.inode == inode:
                    return self._make_attr(entry)

        # Fallback for inodes without parent mapping
        kind, db_id = key
        if kind in ("pending", "temp_staging"):
            # Staging file — find in pending map
            for _pi, pmap in self._pending.items():
                for _name, pf in pmap.items():
                    if pf.inode == inode:
                        sz = os.path.getsize(pf.staging_path) if os.path.exists(pf.staging_path) else 0
                        now_ns = int(time.time() * 1e9)
                        attr = pyfuse3.EntryAttributes()
                        attr.st_ino = inode
                        attr.st_mode = stat.S_IFREG | 0o644
                        attr.st_nlink = 1
                        attr.st_size = sz
                        attr.st_uid = pf.caller_uid
                        attr.st_atime_ns = now_ns
                        attr.st_mtime_ns = now_ns
                        attr.st_ctime_ns = now_ns
                        attr.entry_timeout = 0
                        attr.attr_timeout = 0
                        return attr
            raise pyfuse3.FUSEError(errno.ENOENT)
        if kind == "folder":
            attr = pyfuse3.EntryAttributes()
            attr.st_ino = inode
            attr.st_mode = stat.S_IFDIR | 0o755
            attr.st_nlink = 2
            now_ns = int(time.time() * 1e9)
            attr.st_atime_ns = now_ns
            attr.st_mtime_ns = now_ns
            attr.st_ctime_ns = now_ns
            attr.entry_timeout = 5
            attr.attr_timeout = 5
            return attr
        elif kind == "doc":
            def _fetch_doc_attr():
                with _get_session() as db:
                    doc = db.get(Document, db_id)
                    if doc is None or doc.deleted_at is not None:
                        return None
                    file_rec = db.execute(select(File).where(File.document_id == doc.id).limit(1)).scalar_one_or_none()
                    return (
                        file_rec.file_size if file_rec else 0,
                        int(doc.updated_at.timestamp() * 1e9) if doc.updated_at else int(time.time() * 1e9),
                    )
            result = await trio.to_thread.run_sync(_fetch_doc_attr)
            if result is None:
                raise pyfuse3.FUSEError(errno.ENOENT)
            file_size, mtime_ns = result
            attr = pyfuse3.EntryAttributes()
            attr.st_ino = inode
            attr.st_mode = stat.S_IFREG | 0o644
            attr.st_nlink = 1
            attr.st_size = file_size
            attr.st_atime_ns = mtime_ns
            attr.st_mtime_ns = mtime_ns
            attr.st_ctime_ns = mtime_ns
            attr.entry_timeout = 5
            attr.attr_timeout = 5
            return attr
        raise pyfuse3.FUSEError(errno.ENOENT)

    async def lookup(self, parent_inode: int, name: bytes, ctx=None):
        sname = _nfc(name.decode("utf-8", errors="surrogateescape"))

        # .healthcheck for Docker healthcheck
        if parent_inode == ROOT_INODE and sname == ".healthcheck":
            ino = _get_or_alloc_inode("special", "healthcheck")
            attr = pyfuse3.EntryAttributes()
            attr.st_ino = ino
            attr.st_mode = stat.S_IFREG | 0o444
            attr.st_nlink = 1
            attr.st_size = 3
            now_ns = int(time.time() * 1e9)
            attr.st_atime_ns = now_ns
            attr.st_mtime_ns = now_ns
            attr.st_ctime_ns = now_ns
            attr.entry_timeout = 300
            attr.attr_timeout = 300
            return attr

        # Check pending (staging) first
        pf = self._pending.get(parent_inode, {}).get(sname)
        if pf and not pf.deleted and not pf.is_temp:
            sz = os.path.getsize(pf.staging_path) if os.path.exists(pf.staging_path) else 0
            now_ns = int(time.time() * 1e9)
            attr = pyfuse3.EntryAttributes()
            attr.st_ino = pf.inode
            attr.st_mode = stat.S_IFREG | 0o644
            attr.st_nlink = 1
            attr.st_size = sz
            attr.st_uid = pf.caller_uid
            attr.st_atime_ns = now_ns
            attr.st_mtime_ns = now_ns
            attr.st_ctime_ns = now_ns
            attr.entry_timeout = 0
            attr.attr_timeout = 0
            return attr

        entry = await self._lookup_entry(parent_inode, sname)
        if entry is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        # Permission filter
        if ctx is not None:
            is_admin, caller_gids = await trio.to_thread.run_sync(
                lambda: _get_user_info_sync(ctx.uid)
            )
            if not _can_see_entry(entry, ctx.uid, is_admin, caller_gids):
                raise pyfuse3.FUSEError(errno.ENOENT)
        return self._make_attr(entry)

    async def opendir(self, inode: int, ctx):
        key = _inode_key(inode)
        if key is None and inode != ROOT_INODE:
            raise pyfuse3.FUSEError(errno.ENOENT)
        # Store caller uid for readdir permission filtering
        dir_fh = self._next_dir_fh
        self._next_dir_fh += 1
        self._dir_handles[dir_fh] = (inode, ctx.uid if ctx else 0)
        return dir_fh

    async def readdir(self, fh: int, start_id: int, token):
        dir_info = self._dir_handles.get(fh)
        if dir_info is None:
            raise pyfuse3.FUSEError(errno.EBADF)
        inode, caller_uid = dir_info

        fc = await self._get_folder_cache(inode)
        is_admin, caller_gids = await trio.to_thread.run_sync(
            lambda: _get_user_info_sync(caller_uid)
        )

        # Merge DB entries with pending (staging) files
        all_entries: dict[str, CachedEntry] = dict(fc.entries)
        for name, pf in self._pending.get(inode, {}).items():
            if pf.deleted:
                all_entries.pop(name, None)
                continue
            if pf.is_temp:
                continue
            sz = os.path.getsize(pf.staging_path) if os.path.exists(pf.staging_path) else 0
            now_ns = int(time.time() * 1e9)
            all_entries[name] = CachedEntry(
                inode=pf.inode, name=name, is_dir=False,
                size=sz, mode=stat.S_IFREG | 0o644,
                uid=pf.caller_uid, gid=0, mtime_ns=now_ns,
                storage_path=pf.staging_path,
                owner_uid=pf.caller_uid, others_read=True,
            )

        entries = sorted(all_entries.values(), key=lambda e: e.inode)
        for entry in entries:
            if entry.inode <= start_id:
                continue
            # Hide temp files/dirs from listing
            if _is_temp_file(entry.name) or _is_temp_dir(entry.name):
                continue
            if not _can_see_entry(entry, caller_uid, is_admin, caller_gids):
                continue
            name_bytes = entry.name.encode("utf-8", errors="surrogateescape")
            if not pyfuse3.readdir_reply(token, name_bytes, self._make_attr(entry), entry.inode):
                break

    async def releasedir(self, fh: int):
        self._dir_handles.pop(fh, None)

    async def open(self, inode: int, flags: int, ctx):
        key = _inode_key(inode)
        if key is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        kind, db_id = key

        # .healthcheck
        if kind == "special" and db_id == "healthcheck":
            fh = self._next_fh; self._next_fh += 1
            self._open_files[fh] = {"fd": -1, "inode": inode, "kind": "healthcheck"}
            return pyfuse3.FileInfo(fh=fh)

        # Pending (staging) file?
        if kind in ("pending", "temp_staging"):
            for _pi, pmap in self._pending.items():
                for _name, pf in pmap.items():
                    if pf.inode == inode and os.path.exists(pf.staging_path):
                        oflags = os.O_RDWR if (flags & (os.O_WRONLY | os.O_RDWR)) else os.O_RDONLY
                        fd = os.open(pf.staging_path, oflags)
                        fh = self._next_fh; self._next_fh += 1
                        self._open_files[fh] = {"fd": fd, "inode": inode, "kind": "staging",
                                                 "pending": pf}
                        return pyfuse3.FileInfo(fh=fh)
            raise pyfuse3.FUSEError(errno.ENOENT)

        if kind not in ("doc", "folder", "root"):
            raise pyfuse3.FUSEError(errno.EISDIR if kind == "folder" else errno.ENOENT)
        if kind in ("folder", "root"):
            raise pyfuse3.FUSEError(errno.EISDIR)

        # DB file — permission check
        entry = await self._find_entry_by_inode(inode)
        storage_path = ""
        if entry is not None:
            if ctx is not None:
                is_admin, caller_gids = await trio.to_thread.run_sync(
                    lambda: _get_user_info_sync(ctx.uid))
                if not _can_see_entry(entry, ctx.uid, is_admin, caller_gids):
                    raise pyfuse3.FUSEError(errno.EACCES)
            storage_path = entry.storage_path

        if not storage_path:
            def _fetch():
                with _get_session() as db:
                    fr = db.execute(select(File).where(File.document_id == db_id).limit(1)).scalar_one_or_none()
                    if fr: return fr.storage_path
                    d = db.get(Document, db_id)
                    return d.source_path if d else ""
            storage_path = await trio.to_thread.run_sync(_fetch) or ""

        if not storage_path or not os.path.exists(storage_path):
            raise pyfuse3.FUSEError(errno.ENOENT)

        # Write permission check for DB files
        if (flags & (os.O_WRONLY | os.O_RDWR)) and entry is not None and ctx is not None:
            is_admin, caller_gids = await trio.to_thread.run_sync(
                lambda: _get_user_info_sync(ctx.uid))
            if not _can_write_entry(entry, ctx.uid, is_admin, caller_gids):
                raise pyfuse3.FUSEError(errno.EACCES)

        oflags = os.O_RDWR if (flags & (os.O_WRONLY | os.O_RDWR)) else os.O_RDONLY
        fd = os.open(storage_path, oflags)
        fh = self._next_fh; self._next_fh += 1
        self._open_files[fh] = {"fd": fd, "inode": inode, "kind": "db",
                                 "doc_id": db_id, "storage_path": storage_path, "dirty": False}
        return pyfuse3.FileInfo(fh=fh)

    async def read(self, fh: int, off: int, size: int):
        info = self._open_files.get(fh)
        if info is None:
            raise pyfuse3.FUSEError(errno.EBADF)
        fd = info["fd"]
        if fd == -1:
            return b"ok\n"[off:off + size]
        return os.pread(fd, size, off)

    async def write(self, fh: int, off: int, buf):
        info = self._open_files.get(fh)
        if info is None:
            raise pyfuse3.FUSEError(errno.EBADF)
        fd = info["fd"]
        if fd < 0:
            raise pyfuse3.FUSEError(errno.EBADF)
        written = os.pwrite(fd, buf, off)
        info["dirty"] = True
        return written

    async def release(self, fh: int):
        info = self._open_files.pop(fh, None)
        if info is None:
            return
        fd = info["fd"]
        if fd >= 0:
            os.close(fd)

        # Staging file closed → queue for DB sync
        if info.get("kind") == "staging":
            pf = info.get("pending")
            if pf and not pf.is_temp and not pf.deleted:
                pf.closed = True
                self._sync_queue.append(pf)
        # DB file modified → queue for reindex
        elif info.get("kind") == "db" and info.get("dirty"):
            doc_id = info.get("doc_id")
            spath = info.get("storage_path")
            if doc_id and spath:
                self._sync_queue.append(("reindex", doc_id, spath))

    async def access(self, inode: int, mode, ctx):
        return True

    async def getxattr(self, inode, name, ctx):
        raise pyfuse3.FUSEError(errno.ENODATA)

    async def listxattr(self, inode, ctx):
        return []

    async def statfs(self, ctx):
        s = pyfuse3.StatvfsData()
        s.f_bsize = 4096
        s.f_frsize = 4096
        # Report real disk usage from storage path
        storage = os.environ.get("STORAGE_PATH", "/data/storage")
        try:
            st = os.statvfs(storage)
            s.f_blocks = st.f_blocks
            s.f_bfree = st.f_bfree
            s.f_bavail = st.f_bavail
        except OSError:
            s.f_blocks = 1024 * 1024
            s.f_bfree = 512 * 1024
            s.f_bavail = 512 * 1024
        s.f_files = 1000000
        s.f_ffree = 999000
        s.f_favail = 999000
        s.f_namemax = 255
        return s

    # ------------------------------------------------------------------ #
    # create — staging only, no DB
    # ------------------------------------------------------------------ #

    async def create(self, parent_inode, name, mode, flags, ctx):
        sname = _nfc(name.decode("utf-8", errors="surrogateescape"))
        is_temp = _is_temp_file(sname)

        # Write permission check on parent folder
        if not is_temp and ctx is not None:
            parent_key = _inode_key(parent_inode)
            folder_id = parent_key[1] if parent_key and parent_key[0] == "folder" else None
            can_write = await trio.to_thread.run_sync(
                lambda: _can_write_folder_sync(folder_id, ctx.uid))
            if not can_write:
                raise pyfuse3.FUSEError(errno.EACCES)

        staging_path = os.path.join(_staging_dir(parent_inode), sname)
        fd = os.open(staging_path, os.O_CREAT | os.O_RDWR | os.O_TRUNC, 0o644)

        kind = "temp_staging" if is_temp else "pending"
        temp_id = str(_uuid.uuid4())
        ino = _get_or_alloc_inode(kind, temp_id, parent_inode)

        pf = PendingFile(inode=ino, name=sname, staging_path=staging_path,
                         parent_inode=parent_inode, caller_uid=ctx.uid if ctx else 0,
                         is_temp=is_temp)
        self._pending.setdefault(parent_inode, {})[sname] = pf

        fh = self._next_fh; self._next_fh += 1
        self._open_files[fh] = {"fd": fd, "inode": ino, "kind": "staging", "pending": pf}

        now_ns = int(time.time() * 1e9)
        attr = pyfuse3.EntryAttributes()
        attr.st_ino = ino
        attr.st_mode = stat.S_IFREG | 0o644
        attr.st_nlink = 1
        attr.st_size = 0
        attr.st_uid = ctx.uid if ctx else 0
        attr.st_gid = ctx.gid if ctx else 0
        attr.st_atime_ns = now_ns
        attr.st_mtime_ns = now_ns
        attr.st_ctime_ns = now_ns
        attr.entry_timeout = 0
        attr.attr_timeout = 0
        return pyfuse3.FileInfo(fh=fh), attr

    # ------------------------------------------------------------------ #
    # unlink — staging: delete file. DB: soft-delete.
    # ------------------------------------------------------------------ #

    async def unlink(self, parent_inode, name, ctx):
        sname = _nfc(name.decode("utf-8", errors="surrogateescape"))

        # Pending (staging) file?
        pf = self._pending.get(parent_inode, {}).get(sname)
        if pf:
            pf.deleted = True
            if os.path.exists(pf.staging_path):
                os.unlink(pf.staging_path)
            self._pending.get(parent_inode, {}).pop(sname, None)
            return

        # DB file
        entry = await self._lookup_entry(parent_inode, sname)
        if entry is None:
            return

        # Write permission check
        if ctx is not None and entry.doc_id:
            is_admin, caller_gids = await trio.to_thread.run_sync(
                lambda: _get_user_info_sync(ctx.uid))
            if not _can_write_entry(entry, ctx.uid, is_admin, caller_gids):
                raise pyfuse3.FUSEError(errno.EACCES)

        fc = self._cache.get(parent_inode)
        if fc and sname in fc.entries:
            del fc.entries[sname]
        if entry.doc_id:
            await trio.to_thread.run_sync(lambda: self._soft_delete_sync(entry.doc_id))
            log.info("Soft-deleted %s (%s)", sname, entry.doc_id)
            parent_key = _inode_key(parent_inode)
            fid = parent_key[1] if parent_key and parent_key[0] == "folder" else None
            self._publish_file_changed(fid)

    def _soft_delete_sync(self, doc_id: str):
        from datetime import datetime, timezone
        with _get_session() as db:
            doc = db.get(Document, doc_id)
            if doc and doc.deleted_at is None:
                doc.deleted_at = datetime.now(timezone.utc)
                db.commit()

    # ------------------------------------------------------------------ #
    # rename — staging: rename file. DB: update title/folder.
    # ------------------------------------------------------------------ #

    async def rename(self, old_parent, old_name, new_parent, new_name, flags, ctx):
        old_sname = _nfc(old_name.decode("utf-8", errors="surrogateescape"))
        new_sname = _nfc(new_name.decode("utf-8", errors="surrogateescape"))

        # Write permission check on source and target parent folders
        if ctx is not None:
            old_key = _inode_key(old_parent)
            old_folder_id = old_key[1] if old_key and old_key[0] == "folder" else None
            can_write_src = await trio.to_thread.run_sync(
                lambda: _can_write_folder_sync(old_folder_id, ctx.uid))
            if not can_write_src:
                raise pyfuse3.FUSEError(errno.EACCES)
            if new_parent != old_parent:
                new_key = _inode_key(new_parent)
                new_folder_id = new_key[1] if new_key and new_key[0] == "folder" else None
                can_write_dst = await trio.to_thread.run_sync(
                    lambda: _can_write_folder_sync(new_folder_id, ctx.uid))
                if not can_write_dst:
                    raise pyfuse3.FUSEError(errno.EACCES)

        # Source is pending (staging)?
        pf = self._pending.get(old_parent, {}).get(old_sname)
        if pf:
            # Move staging file
            new_staging = os.path.join(_staging_dir(new_parent), new_sname)
            if os.path.exists(pf.staging_path):
                os.makedirs(os.path.dirname(new_staging), exist_ok=True)
                os.rename(pf.staging_path, new_staging)
            # Update pending map
            self._pending.get(old_parent, {}).pop(old_sname, None)
            pf.name = new_sname
            pf.staging_path = new_staging
            pf.parent_inode = new_parent
            self._pending.setdefault(new_parent, {})[new_sname] = pf
            self._cache.invalidate(old_parent)
            if new_parent != old_parent:
                self._cache.invalidate(new_parent)
            return

        # Source is DB entry
        old_entry = await self._lookup_entry(old_parent, old_sname)
        if old_entry and old_entry.doc_id:
            new_folder_id = None
            key = _inode_key(new_parent)
            if key and key[0] == "folder":
                new_folder_id = key[1]

            def _do_rename():
                with _get_session() as db:
                    doc = db.get(Document, old_entry.doc_id)
                    if doc:
                        doc.title = new_sname
                        if new_parent != old_parent:
                            doc.folder_id = new_folder_id
                        db.commit()
            await trio.to_thread.run_sync(_do_rename)
            log.info("Renamed document: %s -> %s", old_sname, new_sname)
        elif old_entry and old_entry.is_dir and old_entry.folder_db_id:
            def _do_folder_rename():
                with _get_session() as db:
                    folder = db.get(Folder, old_entry.folder_db_id)
                    if folder:
                        folder.name = new_sname
                        if new_parent != old_parent:
                            new_key = _inode_key(new_parent)
                            folder.parent_id = new_key[1] if new_key and new_key[0] == "folder" else None
                        db.commit()
            await trio.to_thread.run_sync(_do_folder_rename)
            log.info("Renamed folder: %s -> %s", old_sname, new_sname)

        self._cache.invalidate(old_parent)
        if new_parent != old_parent:
            self._cache.invalidate(new_parent)

    # ------------------------------------------------------------------ #
    # mkdir / rmdir — DB operations (folder structure, not file content)
    # ------------------------------------------------------------------ #

    async def mkdir(self, parent_inode, name, mode, ctx):
        sname = _nfc(name.decode("utf-8", errors="surrogateescape"))
        parent_key = _inode_key(parent_inode)
        parent_folder_id = parent_key[1] if parent_key and parent_key[0] == "folder" else None

        # Write permission check on parent folder
        if ctx is not None:
            can_write = await trio.to_thread.run_sync(
                lambda: _can_write_folder_sync(parent_folder_id, ctx.uid))
            if not can_write:
                raise pyfuse3.FUSEError(errno.EACCES)

        def _do_mkdir():
            with _get_session() as db:
                user = db.execute(select(User).where(User.unix_uid == (ctx.uid if ctx else 0))).scalar_one_or_none()
                user_id = user.id if user else None
                group_id, group_read, group_write, others_read, others_write = None, False, False, True, False
                if parent_folder_id:
                    pf = db.get(Folder, parent_folder_id)
                    if pf:
                        group_id = pf.group_id
                        group_read, group_write = pf.group_read, pf.group_write
                        others_read, others_write = pf.others_read, pf.others_write
                folder = Folder(name=sname, parent_id=parent_folder_id, owner_id=user_id,
                                group_id=group_id, group_read=group_read, group_write=group_write,
                                others_read=others_read, others_write=others_write)
                db.add(folder)
                db.commit()
                return str(folder.id)

        folder_id = await trio.to_thread.run_sync(_do_mkdir)
        ino = _get_or_alloc_inode("folder", folder_id, parent_inode)
        now_ns = int(time.time() * 1e9)
        attr = pyfuse3.EntryAttributes()
        attr.st_ino = ino
        attr.st_mode = stat.S_IFDIR | 0o755
        attr.st_nlink = 2
        attr.st_uid = ctx.uid if ctx else 0
        attr.st_gid = ctx.gid if ctx else 0
        attr.st_atime_ns = now_ns
        attr.st_mtime_ns = now_ns
        attr.st_ctime_ns = now_ns
        attr.entry_timeout = 0
        attr.attr_timeout = 0
        self._cache.invalidate(parent_inode)
        log.info("Created folder: %s", sname)
        return attr

    async def rmdir(self, parent_inode, name, ctx):
        sname = _nfc(name.decode("utf-8", errors="surrogateescape"))
        entry = await self._lookup_entry(parent_inode, sname)
        if entry is None or not entry.is_dir:
            raise pyfuse3.FUSEError(errno.ENOENT)
        folder_id = entry.folder_db_id
        if not folder_id:
            raise pyfuse3.FUSEError(errno.EPERM)

        # Write permission check on parent folder
        if ctx is not None:
            parent_key = _inode_key(parent_inode)
            parent_folder_id = parent_key[1] if parent_key and parent_key[0] == "folder" else None
            can_write = await trio.to_thread.run_sync(
                lambda: _can_write_folder_sync(parent_folder_id, ctx.uid))
            if not can_write:
                raise pyfuse3.FUSEError(errno.EACCES)

        def _do_rmdir():
            with _get_session() as db:
                if db.execute(select(Folder.id).where(Folder.parent_id == folder_id).limit(1)).scalar_one_or_none():
                    return "ENOTEMPTY"
                if db.execute(select(Document.id).where(Document.folder_id == folder_id, Document.deleted_at.is_(None)).limit(1)).scalar_one_or_none():
                    return "ENOTEMPTY"
                folder = db.get(Folder, folder_id)
                if folder:
                    db.delete(folder)
                    db.commit()
                return "OK"

        result = await trio.to_thread.run_sync(_do_rmdir)
        if result == "ENOTEMPTY":
            raise pyfuse3.FUSEError(errno.ENOTEMPTY)
        self._cache.invalidate(parent_inode)
        log.info("Removed folder: %s", sname)

    # ------------------------------------------------------------------ #
    # setattr — handle truncate + timestamps
    # ------------------------------------------------------------------ #

    async def setattr(self, inode, attr, fields, fh, ctx):
        if fields.update_size and fh is not None:
            info = self._open_files.get(fh)
            if info and info["fd"] >= 0:
                os.ftruncate(info["fd"], attr.st_size)
                info["dirty"] = True
        if fields.update_mtime or fields.update_atime:
            storage_path = None
            if fh is not None:
                info = self._open_files.get(fh)
                if info:
                    pf = info.get("pending")
                    storage_path = pf.staging_path if pf else info.get("storage_path")
            if storage_path and os.path.exists(storage_path):
                try:
                    st = os.stat(storage_path)
                    os.utime(storage_path, ns=(
                        attr.st_atime_ns if fields.update_atime else st.st_atime_ns,
                        attr.st_mtime_ns if fields.update_mtime else st.st_mtime_ns,
                    ))
                except OSError:
                    pass
        return await self.getattr(inode, ctx)

    # ------------------------------------------------------------------ #
    # Background sync worker
    # ------------------------------------------------------------------ #

    async def _redis_cache_subscriber(self):
        """Subscribe to Redis for cache invalidation from Web UI."""
        import redis as sync_redis
        redis_url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
        while True:
            try:
                r = sync_redis.from_url(redis_url, decode_responses=True)
                pubsub = r.pubsub()
                pubsub.subscribe("smb:cache_invalidate")
                log.info("Redis cache subscriber connected")

                def _listen():
                    while True:
                        msg = pubsub.get_message(timeout=1)
                        if msg and msg["type"] == "message":
                            folder_id = msg["data"]
                            if folder_id == "_root":
                                self._cache.invalidate(ROOT_INODE)
                            else:
                                key = ("folder", folder_id)
                                ino = _key_to_inode.get(key)
                                if ino:
                                    self._cache.invalidate(ino)
                            log.debug("Cache invalidated for folder %s", folder_id)

                await trio.to_thread.run_sync(_listen)
            except Exception:
                log.warning("Redis subscriber error, retrying in 5s", exc_info=True)
                await trio.sleep(5)

    async def _background_sync(self):
        """Periodically sync closed staging files to DB."""
        while True:
            await trio.sleep(1)
            to_process = []
            remaining = []
            for item in self._sync_queue:
                if isinstance(item, tuple) and item[0] == "reindex":
                    to_process.append(item)
                elif isinstance(item, PendingFile) and item.closed and not item.deleted:
                    to_process.append(item)
                else:
                    remaining.append(item)
            self._sync_queue = remaining

            for item in to_process:
                try:
                    if isinstance(item, tuple) and item[0] == "reindex":
                        _, doc_id, spath = item
                        await trio.to_thread.run_sync(lambda did=doc_id, sp=spath: self._reindex_sync(did, sp))
                    elif isinstance(item, PendingFile):
                        await trio.to_thread.run_sync(lambda pf=item: self._commit_pending_sync(pf))
                except Exception:
                    log.exception("Background sync error")

    def _commit_pending_sync(self, pf: PendingFile):
        """Move staging file to permanent storage, create Document+File+Job."""
        if not os.path.exists(pf.staging_path):
            return
        # Skip empty files (Finder creates empty then writes in a second pass)
        if os.path.getsize(pf.staging_path) == 0:
            os.unlink(pf.staging_path)
            log.info("Skipped empty staging file: %s", pf.name)
            return

        key = _inode_key(pf.parent_inode)
        folder_id = key[1] if key and key[0] == "folder" else None

        # Skip if same-name active document already exists in this folder
        with _get_session() as db:
            q = select(Document.id).where(
                Document.title == pf.name,
                Document.deleted_at.is_(None),
            )
            if folder_id:
                q = q.where(Document.folder_id == folder_id)
            else:
                q = q.where(Document.folder_id.is_(None))
            existing = db.execute(q.limit(1)).scalar_one_or_none()
            if existing:
                os.unlink(pf.staging_path)
                log.info("Skipped duplicate: %s already exists in folder", pf.name)
                return

        final_path = _final_storage_path(pf.name)
        shutil.move(pf.staging_path, final_path)
        # Update pending entry to point to final path so open() works during transition
        pf.staging_path = final_path
        file_type = _get_file_type(pf.name)
        file_size = os.path.getsize(final_path) if os.path.exists(final_path) else 0

        with _get_session() as db:
            user = db.execute(select(User).where(User.unix_uid == pf.caller_uid)).scalar_one_or_none()
            if not user:
                user = db.execute(select(User).limit(1)).scalar_one_or_none()
            if not user:
                log.error("No user for uid %d", pf.caller_uid)
                return
            user_id = user.id

            group_id, group_read, group_write, others_read, others_write = None, False, False, True, False
            if folder_id:
                folder = db.get(Folder, folder_id)
                if folder:
                    group_id = folder.group_id
                    group_read, group_write = folder.group_read, folder.group_write
                    others_read, others_write = folder.others_read, folder.others_write

            doc = Document(title=pf.name, source_path=final_path, file_type=file_type,
                           content="", owner_id=user_id, group_id=group_id,
                           group_read=group_read, group_write=group_write,
                           others_read=others_read, others_write=others_write,
                           created_by_id=user_id, updated_by_id=user_id,
                           processing_status="pending", folder_id=folder_id, source="smb")
            db.add(doc)
            db.flush()
            import mimetypes
            mime = mimetypes.guess_type(pf.name)[0] or "application/octet-stream"
            db.add(File(document_id=doc.id, filename=pf.name, storage_path=final_path,
                        file_size=file_size, mime_type=mime))
            db.add(Job(job_type="document_processing", status="pending", max_attempts=3,
                       payload={"doc_id": str(doc.id), "storage_path": final_path,
                                "file_type": file_type, "filename": pf.name}))
            db.commit()
            log.info("Synced %s -> %s (%s)", pf.name, doc.id, final_path)

        # Remove from pending, invalidate cache
        p = self._pending.get(pf.parent_inode, {})
        if pf.name in p and p[pf.name] is pf:
            del p[pf.name]
        self._cache.invalidate(pf.parent_inode)

        # Notify Web UI that files changed
        self._publish_file_changed(folder_id)

    def _get_redis(self):
        """Get or create a shared sync Redis connection."""
        if not hasattr(self, "_redis") or self._redis is None:
            import redis as sync_redis
            redis_url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
            self._redis = sync_redis.from_url(redis_url, decode_responses=True)
        return self._redis

    def _publish_file_changed(self, folder_id: str | None):
        """Notify Web UI that files changed in a folder."""
        try:
            self._get_redis().publish("smb:file_changed", folder_id or "_root")
        except Exception:
            self._redis = None  # reset on error

    def _reindex_sync(self, doc_id: str, storage_path: str):
        with _get_session() as db:
            doc = db.get(Document, doc_id)
            if not doc:
                return
            doc.processing_status = "pending"
            fr = db.execute(select(File).where(File.document_id == doc_id).limit(1)).scalar_one_or_none()
            if fr and os.path.exists(storage_path):
                fr.file_size = os.path.getsize(storage_path)
            db.add(Job(job_type="document_processing", status="pending", max_attempts=3,
                       payload={"doc_id": str(doc.id), "storage_path": storage_path,
                                "file_type": doc.file_type or "", "filename": doc.title or ""}))
            db.commit()
            log.info("Re-indexed %s", doc.title)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="LAS FUSE Server")
    parser.add_argument("--mountpoint", default="/mnt/base/fs")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    _init_db()

    fuse_options = set(pyfuse3.default_options)
    fuse_options.discard("default_permissions")
    fuse_options.add("fsname=las-fuse")
    fuse_options.add("allow_other")

    fs = LASFuseServer()
    pyfuse3.init(fs, args.mountpoint, fuse_options)

    log.info("LAS FUSE Server mounted at %s", args.mountpoint)

    async def _run():
        async with trio.open_nursery() as nursery:
            nursery.start_soon(pyfuse3.main)
            nursery.start_soon(fs._background_sync)
            nursery.start_soon(fs._redis_cache_subscriber)

    try:
        trio.run(_run)
    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        pyfuse3.close(unmount=True)
        log.info("FUSE unmounted")


if __name__ == "__main__":
    main()
