"""
Minimal FUSE PoC daemon for Phase 0 verification.

Serves a read-only virtual filesystem with fixed test files.
Used to verify Docker FUSE mount propagation and Samba integration.

Usage:
    python -m app.fuse_poc [--mountpoint /mnt/las-fuse]
"""

import argparse
import errno
import logging
import os
import stat
import time

import pyfuse3
import trio

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Virtual filesystem data (fixed for PoC)
# --------------------------------------------------------------------------- #

# inode allocation:
#   1 = root directory
#   2 = test.txt
#   3 = hello.pdf
#   4 = .healthcheck  (for Docker healthcheck: stat /mnt/las-fuse/.healthcheck)

_FILES = {
    b"test.txt": {
        "inode": 2,
        "content": b"This is a test file served by the LAS FUSE daemon.\n",
        "mode": 0o100644,
    },
    b"hello.pdf": {
        "inode": 3,
        "content": b"%PDF-1.0 (fake PDF content for PoC testing)\n",
        "mode": 0o100644,
    },
    b".healthcheck": {
        "inode": 4,
        "content": b"ok\n",
        "mode": 0o100444,
    },
}

_INODE_TO_NAME = {info["inode"]: name for name, info in _FILES.items()}

ROOT_INODE = pyfuse3.ROOT_INODE  # 1


# --------------------------------------------------------------------------- #
# FUSE Operations
# --------------------------------------------------------------------------- #


class LASFusePoc(pyfuse3.Operations):
    """Read-only FUSE filesystem with fixed test data."""

    def _make_entry(self, inode: int) -> pyfuse3.EntryAttributes:
        entry = pyfuse3.EntryAttributes()
        entry.st_ino = inode
        entry.generation = 0
        entry.entry_timeout = 5
        entry.attr_timeout = 5
        now_ns = int(time.time() * 1e9)
        entry.st_atime_ns = now_ns
        entry.st_mtime_ns = now_ns
        entry.st_ctime_ns = now_ns

        if inode == ROOT_INODE:
            entry.st_mode = stat.S_IFDIR | 0o755
            entry.st_nlink = 2
            entry.st_size = 0
        else:
            name = _INODE_TO_NAME.get(inode)
            if name is None:
                raise pyfuse3.FUSEError(errno.ENOENT)
            info = _FILES[name]
            entry.st_mode = info["mode"]
            entry.st_nlink = 1
            entry.st_size = len(info["content"])

        entry.st_uid = os.getuid()
        entry.st_gid = os.getgid()
        return entry

    async def getattr(self, inode: int, ctx=None):
        return self._make_entry(inode)

    async def lookup(self, parent_inode: int, name: bytes, ctx=None):
        if parent_inode != ROOT_INODE:
            log.debug("lookup: parent %d not root, ENOENT", parent_inode)
            raise pyfuse3.FUSEError(errno.ENOENT)
        info = _FILES.get(name)
        if info is None:
            log.debug("lookup: %r not found, ENOENT", name)
            raise pyfuse3.FUSEError(errno.ENOENT)
        log.debug("lookup: %r -> inode %d", name, info["inode"])
        return self._make_entry(info["inode"])

    async def opendir(self, inode: int, ctx):
        if inode != ROOT_INODE:
            raise pyfuse3.FUSEError(errno.ENOENT)
        return inode

    async def readdir(self, fh: int, start_id: int, token):
        entries = sorted(_FILES.items(), key=lambda x: x[1]["inode"])
        for name, info in entries:
            if info["inode"] <= start_id:
                continue
            if not pyfuse3.readdir_reply(token, name, self._make_entry(info["inode"]), info["inode"]):
                break

    async def open(self, inode: int, flags: int, ctx):
        # Read-only: reject writes
        if flags & (os.O_WRONLY | os.O_RDWR):
            raise pyfuse3.FUSEError(errno.EROFS)
        name = _INODE_TO_NAME.get(inode)
        if name is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        return pyfuse3.FileInfo(fh=inode)

    async def read(self, fh: int, off: int, size: int):
        name = _INODE_TO_NAME.get(fh)
        if name is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        content = _FILES[name]["content"]
        return content[off : off + size]

    # Reject all write operations
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

    async def access(self, inode, mode, ctx):
        # PoC: allow all access. Production will check LAS permissions.
        return True

    async def getxattr(self, inode, name, ctx):
        raise pyfuse3.FUSEError(errno.ENODATA)

    async def listxattr(self, inode, ctx):
        return []

    async def statfs(self, ctx):
        stat_ = pyfuse3.StatvfsData()
        stat_.f_bsize = 4096
        stat_.f_frsize = 4096
        stat_.f_blocks = 1024 * 1024  # ~4GB total
        stat_.f_bfree = 512 * 1024    # ~2GB free
        stat_.f_bavail = 512 * 1024
        stat_.f_files = len(_FILES)
        stat_.f_ffree = 1000000
        stat_.f_favail = 1000000
        stat_.f_namemax = 255
        return stat_


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main():
    parser = argparse.ArgumentParser(description="LAS FUSE PoC daemon")
    parser.add_argument(
        "--mountpoint",
        default="/mnt/las-fuse",
        help="FUSE mount point (default: /mnt/las-fuse)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    mountpoint = args.mountpoint
    # mountpoint is created by the shell entrypoint; skip makedirs here

    fuse_options = set(pyfuse3.default_options)
    fuse_options.discard("default_permissions")
    fuse_options.add("fsname=las-fuse-poc")
    fuse_options.add("allow_other")

    fs = LASFusePoc()
    pyfuse3.init(fs, mountpoint, fuse_options)

    log.info("LAS FUSE PoC mounted at %s", mountpoint)
    log.info("Files: %s", [name.decode() for name in _FILES])

    try:
        trio.run(pyfuse3.main)
    except KeyboardInterrupt:
        log.info("Shutting down...")
    finally:
        pyfuse3.close(unmount=True)
        log.info("FUSE unmounted")


if __name__ == "__main__":
    main()
