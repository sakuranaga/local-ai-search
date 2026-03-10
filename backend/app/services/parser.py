import os
from pathlib import Path


async def parse_file(path: str, file_type: str) -> str:
    """Extract text content from a file based on its type."""
    file_type = file_type.lower().lstrip(".")

    if file_type in ("md", "txt", "text", "markdown"):
        return await _parse_text(path)
    elif file_type == "pdf":
        return await _parse_pdf(path)
    elif file_type in ("docx", "doc"):
        return await _parse_docx(path)
    else:
        # Attempt plain-text read as fallback
        return await _parse_text(path)


async def _parse_text(path: str) -> str:
    """Read a plain text / markdown file."""
    import asyncio

    def _read() -> str:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    return await asyncio.get_event_loop().run_in_executor(None, _read)


async def _parse_pdf(path: str) -> str:
    """Extract text from a PDF using PyMuPDF (fitz)."""
    import asyncio

    def _extract() -> str:
        import fitz  # PyMuPDF

        text_parts: list[str] = []
        with fitz.open(path) as doc:
            for page in doc:
                text_parts.append(page.get_text())
        return "\n".join(text_parts)

    return await asyncio.get_event_loop().run_in_executor(None, _extract)


async def _parse_docx(path: str) -> str:
    """Extract text from a DOCX file."""
    import asyncio

    def _extract() -> str:
        from docx import Document as DocxDocument

        doc = DocxDocument(path)
        return "\n".join(para.text for para in doc.paragraphs)

    return await asyncio.get_event_loop().run_in_executor(None, _extract)


def chunk_text(text: str, chunk_size: int = 800, overlap: int = 100) -> list[str]:
    """Split text into overlapping chunks by character count.

    Attempts to break on paragraph / sentence boundaries when possible.
    """
    if not text or not text.strip():
        return []

    chunks: list[str] = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = min(start + chunk_size, text_len)

        # If we're not at the very end, try to find a good break point
        if end < text_len:
            # Look for paragraph break first
            para_break = text.rfind("\n\n", start, end)
            if para_break > start + chunk_size // 2:
                end = para_break + 2  # include the double newline
            else:
                # Look for single newline
                newline = text.rfind("\n", start + chunk_size // 2, end)
                if newline > start:
                    end = newline + 1
                else:
                    # Look for sentence end
                    for sep in (". ", "! ", "? "):
                        pos = text.rfind(sep, start + chunk_size // 2, end)
                        if pos > start:
                            end = pos + len(sep)
                            break

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        # Move start forward, applying overlap
        start = max(end - overlap, start + 1)
        if start >= text_len:
            break

    return chunks
