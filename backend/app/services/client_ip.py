"""The client's address.

nginx sets X-Real-IP to the connection's address ($remote_addr) over anything the client wrote. The backend is not
published, so only nginx sets X-Real-IP. X-Forwarded-For is never read here: nginx only appends the connection to
what the client sent, so its first value is whatever the client wrote.
"""

from __future__ import annotations

import ipaddress

_MAX = 45  # the audit log's column (String(45))


def parse_ip(raw: str | None) -> str | None:
    """An address as one plain value (IPv4 mapped in IPv6 as IPv4); None when it is not exactly one address."""
    if not raw:
        return None
    try:
        ip = ipaddress.ip_address(raw.strip())
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    out = str(ip)
    return out if len(out) <= _MAX else None


def parse_remote_addr(raw: str | None) -> str | None:
    """An address from "ip:port" or "[ipv6]:port" (as tusd's hook sends RemoteAddr), or from a bare address."""
    if not raw:
        return None
    raw = raw.strip()
    if raw.startswith("["):
        host = raw[1:raw.find("]")] if "]" in raw else ""
    elif raw.count(":") == 1:
        host = raw.split(":", 1)[0]
    else:
        host = raw
    return parse_ip(host)


def client_ip(request) -> str | None:
    """X-Real-IP as nginx set it, else the connection's address; None when neither is an address."""
    if request is None:
        return None
    return parse_ip(request.headers.get("x-real-ip")) or parse_ip(request.client.host if request.client else None)


def header(headers: dict | None, name: str) -> str | None:
    """The first value of a header in a map of lists (tusd's hook: Go's http.Header), its name in any case."""
    for key, values in (headers or {}).items():
        if key.lower() == name.lower():
            if isinstance(values, list):
                return values[0] if values else None
            return values
    return None
