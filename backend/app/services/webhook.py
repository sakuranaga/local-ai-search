"""Webhook notification service.

Sends JSON payloads to registered webhook endpoints on system events.
Uses the same batching pattern as mail notifications.
"""

import asyncio
import hashlib
import hmac
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import async_session
from app.models import WebhookEndpoint

logger = logging.getLogger(__name__)

_BATCH_DELAY = 5  # seconds
_TIMEOUT = 30  # seconds
_MAX_RETRIES = 3

# key = (event, username), value = list of filenames
_batch_buckets: dict[tuple[str, str], list[str]] = defaultdict(list)
_batch_timers: dict[tuple[str, str], asyncio.TimerHandle] = {}


_EVENT_LABELS = {
    "login": ("ログイン", "🔑"),
    "create": ("ファイルアップロード", "📄"),
    "update": ("ファイル更新", "📝"),
    "delete": ("ファイル削除", "🗑️"),
    "test": ("テスト", "🔔"),
}


def _format_message(payload: dict) -> str:
    """Build a human-readable message from a payload."""
    event = payload.get("event", "")
    username = payload.get("username", "")
    label, icon = _EVENT_LABELS.get(event, (event, "📌"))
    data = payload.get("data", {})

    if event == "login":
        ip = data.get("ip_address") or ""
        msg = f"{icon} **{label}**\n{username} がログインしました"
        if ip:
            msg += f"\nIP: `{ip}`"
        return msg

    if event == "test":
        return f"{icon} **LAS Webhook テスト**\n接続成功"

    filenames = data.get("filenames", [])
    count = data.get("count", len(filenames))
    if count == 1:
        msg = f"{icon} **{label}**\n{username} が `{filenames[0]}` を処理しました"
    else:
        files_str = "\n".join(f"- `{f}`" for f in filenames[:10])
        msg = f"{icon} **{label}** ({count}件)\n{username}\n{files_str}"
        if count > 10:
            msg += f"\n… 他 {count - 10} 件"
    return msg


def _to_discord(payload: dict) -> dict:
    """Convert payload to Discord webhook format."""
    return {"content": _format_message(payload)}


def _to_slack(payload: dict) -> dict:
    """Convert payload to Slack incoming webhook format."""
    return {"text": _format_message(payload)}


def _sign_payload(secret: str, body: bytes) -> str:
    """Generate HMAC-SHA256 signature."""
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _send_webhook(endpoint: WebhookEndpoint, payload: dict) -> None:
    """POST JSON to a single webhook endpoint with retries."""
    fmt = getattr(endpoint, "format", "json") or "json"
    if fmt == "discord":
        send_payload = _to_discord(payload)
    elif fmt == "slack":
        send_payload = _to_slack(payload)
    else:
        send_payload = payload

    body = json.dumps(send_payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json"}
    if endpoint.secret:
        headers["X-Webhook-Signature"] = _sign_payload(endpoint.secret, body)

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(endpoint.url, content=body, headers=headers)
            if resp.status_code < 400:
                logger.info("Webhook sent: %s → %s (%d)", payload["event"], endpoint.name, resp.status_code)
                return
            logger.warning("Webhook %s returned %d (attempt %d/%d)", endpoint.name, resp.status_code, attempt, _MAX_RETRIES)
        except Exception as e:
            logger.warning("Webhook %s failed (attempt %d/%d): %s", endpoint.name, attempt, _MAX_RETRIES, e)

        if attempt < _MAX_RETRIES:
            await asyncio.sleep(2 ** attempt)  # exponential backoff: 2s, 4s

    logger.error("Webhook %s failed after %d attempts", endpoint.name, _MAX_RETRIES)


async def _dispatch(event: str, payload: dict) -> None:
    """Send payload to all endpoints subscribed to the event."""
    async with async_session() as db:
        col = f"on_{event}"
        result = await db.execute(
            select(WebhookEndpoint)
            .where(WebhookEndpoint.enabled.is_(True))
            .where(getattr(WebhookEndpoint, col).is_(True))
        )
        endpoints = result.scalars().all()

    for ep in endpoints:
        await _send_webhook(ep, payload)


def _flush_batch(event: str, username: str) -> None:
    """Flush a batch bucket and send the aggregated webhook."""
    key = (event, username)
    filenames = _batch_buckets.pop(key, [])
    _batch_timers.pop(key, None)
    if not filenames:
        return

    payload = {
        "event": event,
        "username": username,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": {"filenames": filenames, "count": len(filenames)},
    }
    asyncio.create_task(_dispatch(event, payload))


def _enqueue_batch(event: str, username: str, filenames: list[str]) -> None:
    """Add filenames to the batch bucket and (re)start the flush timer."""
    key = (event, username)
    _batch_buckets[key].extend(filenames)

    old = _batch_timers.pop(key, None)
    if old is not None:
        old.cancel()

    loop = asyncio.get_event_loop()
    _batch_timers[key] = loop.call_later(_BATCH_DELAY, _flush_batch, event, username)


# ── Public API (fire-and-forget) ──────────────────────────────────────

def webhook_login(username: str, ip_address: str | None = None) -> None:
    """Fire-and-forget login webhook."""
    payload = {
        "event": "login",
        "username": username,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": {"ip_address": ip_address},
    }
    asyncio.create_task(_dispatch("login", payload))


def webhook_create(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document creation webhook (batched)."""
    _enqueue_batch("create", username, filenames)


def webhook_update(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document update webhook (batched)."""
    _enqueue_batch("update", username, filenames)


def webhook_delete(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document deletion webhook (batched)."""
    _enqueue_batch("delete", username, filenames)


async def send_test_webhook(url: str, secret: str | None = None, fmt: str = "json") -> str:
    """Send a test webhook. Returns 'ok' or error message."""
    payload = {
        "event": "test",
        "username": "system",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": {"message": "LAS webhook test"},
    }
    if fmt == "discord":
        send_payload = _to_discord(payload)
    elif fmt == "slack":
        send_payload = _to_slack(payload)
    else:
        send_payload = payload

    body = json.dumps(send_payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["X-Webhook-Signature"] = _sign_payload(secret, body)

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, content=body, headers=headers)
        if resp.status_code < 400:
            return "ok"
        return f"HTTP {resp.status_code}: {resp.text[:200]}"
    except Exception as e:
        return str(e)
