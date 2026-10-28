"""The client's address in the audit log: X-Real-IP as nginx set it, never the first X-Forwarded-For."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from app.services import client_ip as cip
from app.services.audit import audit_log


def _request(headers: dict, host: str | None = "172.18.0.5"):
    return SimpleNamespace(headers={k.lower(): v for k, v in headers.items()},
                           client=SimpleNamespace(host=host) if host else None)


def _logged_ip(request=None, **kw) -> str | None:
    db = MagicMock()
    db.flush = AsyncMock()
    entry = asyncio.run(audit_log(db, action="login", request=request, **kw))
    return entry.ip_address


def test_audit_takes_x_real_ip_not_a_forged_x_forwarded_for():
    r = _request({"X-Forwarded-For": "198.51.100.9, 203.0.113.7", "X-Real-IP": "203.0.113.7"})
    assert _logged_ip(r) == "203.0.113.7"


def test_audit_without_x_real_ip_takes_the_connection():
    assert _logged_ip(_request({"X-Forwarded-For": "198.51.100.9"})) == "172.18.0.5"


def test_audit_a_long_or_unreadable_value_is_not_kept():
    assert _logged_ip(_request({"X-Real-IP": "x" * 200})) == "172.18.0.5"
    assert _logged_ip(_request({"X-Real-IP": "x" * 200}, host=None)) is None


def test_audit_ipv4_mapped_and_given_address():
    assert _logged_ip(_request({"X-Real-IP": "::ffff:203.0.113.7"})) == "203.0.113.7"
    assert _logged_ip(None, ip_address="::ffff:192.0.2.1") == "192.0.2.1"
    assert _logged_ip(None) is None


def test_tus_hook_header_and_remote_addr():
    headers = {"X-Forwarded-For": ["198.51.100.9"], "X-Real-Ip": ["203.0.113.7"]}
    assert cip.parse_ip(cip.header(headers, "X-Real-IP")) == "203.0.113.7"
    assert cip.header({"X-Forwarded-For": ["198.51.100.9"]}, "X-Real-IP") is None
    assert cip.parse_remote_addr("203.0.113.7:51234") == "203.0.113.7"
    assert cip.parse_remote_addr("[2001:db8::1]:443") == "2001:db8::1"
    assert cip.parse_remote_addr("garbage") is None
