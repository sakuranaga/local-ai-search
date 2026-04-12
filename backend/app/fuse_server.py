"""
LAS FUSE Server — Read-only virtual filesystem backed by the LAS database.

Maps LAS Folder/Document hierarchy to a POSIX filesystem that Samba can serve.
Actual file I/O is redirected to the existing UUID-based storage.

Usage:
    python -m app.fuse_server [--mountpoint /mnt/base/fs] [--debug]
"""

import argparse
import errno
import logging
import os
import stat
import time
import unicodedata
from collections import OrderedDict
from dataclasses import dataclass, field

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
    others_read: bool = True
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
    # Access control is handled by _can_see_entry (visibility filter).
    # Samba sees all visible entries as fully readable.
    # Phase 2 (write support) will add write bits selectively.
    if is_dir:
        return stat.S_IFDIR | 0o755
    else:
        return stat.S_IFREG | 0o644


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
                group_read=f.group_read, others_read=f.others_read,
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
            doc_others_read = getattr(doc, "others_read", True)
            doc_dl_prohibited = getattr(doc, "download_prohibited", False)

            fc.entries[name] = CachedEntry(
                inode=ino, name=name, is_dir=False,
                size=file_size, mode=mode, uid=owner_uid, gid=owner_gid,
                mtime_ns=mtime_ns, storage_path=storage_path, doc_id=str(doc.id),
                owner_uid=owner_uid, group_gid=owner_gid,
                group_read=doc_group_read, others_read=doc_others_read,
                download_prohibited=doc_dl_prohibited,
            )

    return fc


# Import models after helpers are defined
from app.models import Document, File, Folder, User, Group, GroupMember


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
        self._open_files: dict[int, int] = {}  # fh -> real_fd
        self._next_fh = 1
        self._dir_handles: dict[int, int] = {}  # dir_fh -> caller_uid
        self._next_dir_fh = 1_000_000

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

        entries = sorted(fc.entries.values(), key=lambda e: e.inode)
        for entry in entries:
            if entry.inode <= start_id:
                continue
            if not _can_see_entry(entry, caller_uid, is_admin, caller_gids):
                continue
            name_bytes = entry.name.encode("utf-8", errors="surrogateescape")
            if not pyfuse3.readdir_reply(token, name_bytes, self._make_attr(entry), entry.inode):
                break

    async def releasedir(self, fh: int):
        self._dir_handles.pop(fh, None)

    async def open(self, inode: int, flags: int, ctx):
        if flags & (os.O_WRONLY | os.O_RDWR):
            raise pyfuse3.FUSEError(errno.EROFS)

        key = _inode_key(inode)
        if key is None:
            raise pyfuse3.FUSEError(errno.ENOENT)

        kind, db_id = key

        # .healthcheck special file
        if kind == "special" and db_id == "healthcheck":
            fh = self._next_fh
            self._next_fh += 1
            self._open_files[fh] = -1  # sentinel for healthcheck
            return pyfuse3.FileInfo(fh=fh)

        if kind != "doc":
            raise pyfuse3.FUSEError(errno.EISDIR)

        # Permission check + find storage path via O(1) parent lookup
        entry = await self._find_entry_by_inode(inode)
        storage_path = ""

        if entry is not None:
            if ctx is not None:
                is_admin, caller_gids = await trio.to_thread.run_sync(
                    lambda: _get_user_info_sync(ctx.uid)
                )
                if not _can_see_entry(entry, ctx.uid, is_admin, caller_gids):
                    raise pyfuse3.FUSEError(errno.EACCES)
            storage_path = entry.storage_path

        if not storage_path:
            def _fetch_storage_path():
                with _get_session() as db:
                    file_rec = db.execute(select(File).where(File.document_id == db_id).limit(1)).scalar_one_or_none()
                    if file_rec:
                        return file_rec.storage_path
                    doc = db.get(Document, db_id)
                    if doc:
                        return doc.source_path or ""
                    return ""
            storage_path = await trio.to_thread.run_sync(_fetch_storage_path)

        if not storage_path or not os.path.exists(storage_path):
            raise pyfuse3.FUSEError(errno.ENOENT)

        fd = os.open(storage_path, os.O_RDONLY)
        fh = self._next_fh
        self._next_fh += 1
        self._open_files[fh] = fd
        return pyfuse3.FileInfo(fh=fh)

    async def read(self, fh: int, off: int, size: int):
        fd = self._open_files.get(fh)
        if fd is None:
            raise pyfuse3.FUSEError(errno.EBADF)
        if fd == -1:  # healthcheck
            content = b"ok\n"
            return content[off:off + size]
        return os.pread(fd, size, off)

    async def release(self, fh: int):
        fd = self._open_files.pop(fh, None)
        if fd is not None and fd >= 0:
            os.close(fd)

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

    # Reject writes
    async def write(self, fh, off, buf):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def create(self, parent_inode, name, mode, flags, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def mkdir(self, parent_inode, name, mode, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def unlink(self, parent_inode, name, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def rmdir(self, parent_inode, name, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def rename(self, old_parent, old_name, new_parent, new_name, flags, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)

    async def setattr(self, inode, attr, fields, fh, ctx):
        raise pyfuse3.FUSEError(errno.EROFS)


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

    try:
        trio.run(pyfuse3.main)
    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        pyfuse3.close(unmount=True)
        log.info("FUSE unmounted")


if __name__ == "__main__":
    main()
