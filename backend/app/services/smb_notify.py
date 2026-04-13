"""
Redis pub/sub notifications for SMB ↔ Web UI cache synchronization.

Channels:
  smb:cache_invalidate — Web UI publishes folder_id when docs/folders change.
                          FUSE daemon subscribes and invalidates metadata cache.
  smb:file_changed     — FUSE daemon publishes folder_id after staging sync.
                          Web UI can subscribe for folder refresh.
"""

import logging
import redis.asyncio as redis

from app.config import settings

log = logging.getLogger(__name__)

CACHE_INVALIDATE_CHANNEL = "smb:cache_invalidate"
FILE_CHANGED_CHANNEL = "smb:file_changed"


async def publish_cache_invalidate(folder_id: str | None):
    """Notify FUSE daemon to invalidate cache for a folder."""
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.publish(CACHE_INVALIDATE_CHANNEL, folder_id or "_root")
        await r.aclose()
    except Exception:
        log.debug("Failed to publish cache invalidate", exc_info=True)


async def publish_file_changed(folder_id: str | None):
    """Notify Web UI that files changed in a folder (from SMB)."""
    try:
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.publish(FILE_CHANGED_CHANNEL, folder_id or "_root")
        await r.aclose()
    except Exception:
        log.debug("Failed to publish file changed", exc_info=True)
