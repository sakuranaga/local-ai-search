"""Email notification service.

Sends notifications on system events (login, create, update, delete).
All sending is fire-and-forget in a background thread so it never blocks
the main request/response cycle.
"""

import asyncio
import logging
import smtplib
from collections import defaultdict
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import async_session
from app.models import MailRecipient
from app.services.settings import get_setting

logger = logging.getLogger(__name__)

# ── HTML email template ──────────────────────────────────────────────

_EMAIL_TEMPLATE = """\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;border:1px solid #e0e0e0;overflow:hidden;">
  <div style="background:#1a1a2e;padding:16px 24px;">
    <h1 style="margin:0;color:#fff;font-size:18px;">LAS — Local AI Search</h1>
  </div>
  <div style="padding:24px;">
    <h2 style="margin:0 0 16px;font-size:16px;color:#333;">{title}</h2>
    {body}
  </div>
  <div style="padding:12px 24px;background:#f9f9f9;border-top:1px solid #e0e0e0;font-size:12px;color:#888;">
    この通知は LAS から自動送信されています
  </div>
</div>
</body>
</html>"""


def _render_html(title: str, body_html: str) -> str:
    return _EMAIL_TEMPLATE.format(title=title, body=body_html)


# ── Provider implementations ─────────────────────────────────────────

def _send_smtp(
    host: str, port: int, username: str, password: str,
    from_addr: str, to_addr: str, subject: str, html: str,
) -> None:
    """Send email via SMTP (blocking — run in executor).

    Port 465 → SMTP_SSL (implicit TLS).
    Other ports (587 etc.) → SMTP + STARTTLS.
    """
    msg = MIMEMultipart("alternative")
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html", "utf-8"))

    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=30) as server:
            if username:
                server.login(username, password)
            server.sendmail(from_addr, [to_addr], msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.starttls()
            if username:
                server.login(username, password)
            server.sendmail(from_addr, [to_addr], msg.as_string())


def _send_sendgrid(api_key: str, from_addr: str, to_addr: str, subject: str, html: str) -> None:
    """Send email via SendGrid Web API (blocking)."""
    import httpx
    resp = httpx.post(
        "https://api.sendgrid.com/v3/mail/send",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "personalizations": [{"to": [{"email": to_addr}]}],
            "from": {"email": from_addr},
            "subject": subject,
            "content": [{"type": "text/html", "value": html}],
        },
        timeout=30,
    )
    resp.raise_for_status()


def _send_resend(api_key: str, from_addr: str, to_addr: str, subject: str, html: str) -> None:
    """Send email via Resend API (blocking)."""
    import httpx
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"from": from_addr, "to": [to_addr], "subject": subject, "html": html},
        timeout=30,
    )
    resp.raise_for_status()


def _send_ses(
    region: str, access_key: str, secret_key: str,
    from_addr: str, to_addr: str, subject: str, html: str,
) -> None:
    """Send email via AWS SES (blocking)."""
    import boto3
    client = boto3.client(
        "ses", region_name=region,
        aws_access_key_id=access_key, aws_secret_access_key=secret_key,
    )
    client.send_email(
        Source=from_addr,
        Destination={"ToAddresses": [to_addr]},
        Message={
            "Subject": {"Data": subject, "Charset": "UTF-8"},
            "Body": {"Html": {"Data": html, "Charset": "UTF-8"}},
        },
    )


# ── Core send logic ──────────────────────────────────────────────────

async def _get_mail_config(db: AsyncSession) -> dict:
    """Load all mail-related settings."""
    keys = [
        "mail_provider", "mail_from",
        "smtp_host", "smtp_port", "smtp_username", "smtp_password",
        "sendgrid_api_key", "resend_api_key",
        "ses_region", "ses_access_key", "ses_secret_key",
    ]
    config = {}
    for k in keys:
        config[k] = await get_setting(db, k)
    return config


def _do_send(config: dict, to_addr: str, subject: str, html: str) -> None:
    """Dispatch to the configured provider (blocking)."""
    provider = config["mail_provider"]
    from_addr = config["mail_from"]

    if provider == "smtp":
        _send_smtp(
            host=config["smtp_host"],
            port=int(config.get("smtp_port") or 587),
            username=config["smtp_username"],
            password=config["smtp_password"],
            from_addr=from_addr, to_addr=to_addr, subject=subject, html=html,
        )
    elif provider == "sendgrid":
        _send_sendgrid(config["sendgrid_api_key"], from_addr, to_addr, subject, html)
    elif provider == "resend":
        _send_resend(config["resend_api_key"], from_addr, to_addr, subject, html)
    elif provider == "ses":
        _send_ses(
            config["ses_region"], config["ses_access_key"], config["ses_secret_key"],
            from_addr, to_addr, subject, html,
        )
    else:
        raise ValueError(f"Unknown mail provider: {provider}")


async def _send_to_recipients(event: str, subject: str, body_html: str) -> None:
    """Send notification to all recipients subscribed to the event.

    Runs each send in a thread executor so SMTP timeouts don't block anything.
    """
    async with async_session() as db:
        config = await _get_mail_config(db)
        if not config.get("mail_provider"):
            return  # Mail not configured

        col = f"on_{event}"
        result = await db.execute(
            select(MailRecipient)
            .where(MailRecipient.enabled.is_(True))
            .where(getattr(MailRecipient, col).is_(True))
        )
        recipients = result.scalars().all()

    if not recipients:
        return

    html = _render_html(subject, body_html)
    loop = asyncio.get_event_loop()
    for r in recipients:
        try:
            await loop.run_in_executor(None, _do_send, config, r.email, subject, html)
            logger.info(f"Mail sent: {event} → {r.email}")
        except Exception as e:
            logger.error(f"Mail send failed: {event} → {r.email}: {e}")


# ── Batch aggregation ────────────────────────────────────────────────
# Collects filenames for the same (event, username) within a short window
# and sends a single email instead of one per file.

_BATCH_DELAY = 5  # seconds to wait for more files before sending

# key = (event, username), value = list of filenames
_batch_buckets: dict[tuple[str, str], list[str]] = defaultdict(list)
_batch_timers: dict[tuple[str, str], asyncio.TimerHandle] = {}


def _flush_batch(event: str, username: str) -> None:
    """Flush a batch bucket and send the aggregated notification."""
    key = (event, username)
    filenames = _batch_buckets.pop(key, [])
    _batch_timers.pop(key, None)
    if not filenames:
        return

    event_labels = {
        "create": ("ファイルアップロード通知", "アップロード", "📄"),
        "update": ("ファイル更新通知", "更新", "📄"),
        "delete": ("ファイル削除通知", "削除", "🗑"),
    }
    subject, verb, icon = event_labels[event]

    if len(filenames) == 1:
        body = f"<p><strong>{_esc(username)}</strong> がファイルを{verb}しました。</p>"
        body += f"<p>{icon} {_esc(filenames[0])}</p>"
    else:
        body = f"<p><strong>{_esc(username)}</strong> が {len(filenames)} 件のファイルを{verb}しました。</p>"
        body += "<ul>" + "".join(f"<li>{_esc(f)}</li>" for f in filenames[:20]) + "</ul>"
        if len(filenames) > 20:
            body += f"<p>… 他 {len(filenames) - 20} 件</p>"

    asyncio.create_task(_send_to_recipients(event, subject, body))


def _enqueue_batch(event: str, username: str, filenames: list[str]) -> None:
    """Add filenames to the batch bucket and (re)start the flush timer."""
    key = (event, username)
    _batch_buckets[key].extend(filenames)

    # Cancel existing timer and restart — extends the window for rapid uploads
    old = _batch_timers.pop(key, None)
    if old is not None:
        old.cancel()

    loop = asyncio.get_event_loop()
    _batch_timers[key] = loop.call_later(_BATCH_DELAY, _flush_batch, event, username)


# ── Public API (fire-and-forget) ──────────────────────────────────────

def notify_login(username: str, ip_address: str | None = None) -> None:
    """Fire-and-forget login notification."""
    body = f"<p><strong>{_esc(username)}</strong> がログインしました。</p>"
    if ip_address:
        body += f"<p>IPアドレス: {_esc(ip_address)}</p>"
    asyncio.create_task(
        _send_to_recipients("login", "ログイン通知", body)
    )


def notify_create(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document creation notification (batched)."""
    _enqueue_batch("create", username, filenames)


def notify_update(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document update notification (batched)."""
    _enqueue_batch("update", username, filenames)


def notify_delete(username: str, filenames: list[str]) -> None:
    """Fire-and-forget document deletion notification (batched)."""
    _enqueue_batch("delete", username, filenames)


async def send_test_email(to_addr: str) -> str:
    """Send a test email. Returns 'ok' or error message."""
    async with async_session() as db:
        config = await _get_mail_config(db)
    if not config.get("mail_provider"):
        return "メールプロバイダが設定されていません"
    try:
        html = _render_html("テスト送信", "<p>LAS からのテストメールです。正常に受信できています。</p>")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_send, config, to_addr, "LAS テストメール", html)
        return "ok"
    except Exception as e:
        return str(e)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
