"""Filename sanitization utilities."""


def sanitize_filename(name: str) -> str:
    """Sanitize a filename to prevent path traversal and header injection.

    - Replaces ``/`` with ``-`` to prevent path traversal while keeping
      readability (e.g. ``2026/03/26`` → ``2026-03-26``).
    - Strips null bytes, CR, and LF to prevent path truncation and HTTP
      header injection.
    """
    safe = name.replace("/", "-")
    safe = safe.replace("\0", "").replace("\r", "").replace("\n", "")
    return safe or "unnamed"
