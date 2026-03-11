"""Generate HTML previews for office documents (Excel, PowerPoint)."""

import asyncio
from pathlib import Path

_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 16px; color: #222; background: #fff; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #1a1a1a; color: #e0e0e0; }} }}
  table {{ border-collapse: collapse; width: 100%; margin-bottom: 24px; font-size: 13px; }}
  th, td {{ border: 1px solid #ccc; padding: 6px 10px; text-align: left; white-space: pre-wrap; }}
  @media (prefers-color-scheme: dark) {{ th, td {{ border-color: #444; }} }}
  th {{ background: #f0f0f0; font-weight: 600; }}
  @media (prefers-color-scheme: dark) {{ th {{ background: #2a2a2a; }} }}
  h2 {{ font-size: 16px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ddd; }}
  @media (prefers-color-scheme: dark) {{ h2 {{ border-color: #444; }} }}
  .slide {{ border: 1px solid #ccc; border-radius: 8px; padding: 20px; margin-bottom: 20px; }}
  @media (prefers-color-scheme: dark) {{ .slide {{ border-color: #444; }} }}
  .slide-num {{ font-size: 12px; color: #888; margin-bottom: 8px; }}
  .slide p {{ margin: 4px 0; }}
</style>
</head>
<body>{content}</body>
</html>"""


async def render_preview_html(path: str, file_type: str) -> str:
    """Render an office document as HTML."""
    ft = file_type.lower().lstrip(".")
    if ft in ("xlsx", "xls"):
        return await asyncio.get_event_loop().run_in_executor(None, _render_excel, path)
    elif ft == "pptx":
        return await asyncio.get_event_loop().run_in_executor(None, _render_pptx, path)
    elif ft in ("csv", "tsv"):
        return await asyncio.get_event_loop().run_in_executor(None, _render_csv, path, ft)
    elif ft in ("docx", "doc"):
        return await asyncio.get_event_loop().run_in_executor(None, _render_docx, path)
    else:
        return _HTML_TEMPLATE.format(content="<p>このファイル形式のプレビューには対応していません。</p>")


def _render_excel(path: str) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    parts: list[str] = []

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        parts.append(f"<h2>{_esc(sheet_name)}</h2>")
        parts.append("<table>")
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            cells = [str(c) if c is not None else "" for c in row]
            if not any(c for c in cells):
                continue
            tag = "th" if i == 0 else "td"
            parts.append("<tr>" + "".join(f"<{tag}>{_esc(c)}</{tag}>" for c in cells) + "</tr>")
        parts.append("</table>")

    wb.close()
    return _HTML_TEMPLATE.format(content="\n".join(parts))


def _render_pptx(path: str) -> str:
    from pptx import Presentation

    prs = Presentation(path)
    parts: list[str] = []

    for i, slide in enumerate(prs.slides, 1):
        parts.append(f'<div class="slide">')
        parts.append(f'<div class="slide-num">スライド {i}</div>')
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if text:
                        parts.append(f"<p>{_esc(text)}</p>")
            if shape.has_table:
                parts.append("<table>")
                for ri, row in enumerate(shape.table.rows):
                    tag = "th" if ri == 0 else "td"
                    cells = [cell.text.strip() for cell in row.cells]
                    parts.append("<tr>" + "".join(f"<{tag}>{_esc(c)}</{tag}>" for c in cells) + "</tr>")
                parts.append("</table>")
        parts.append("</div>")

    return _HTML_TEMPLATE.format(content="\n".join(parts))


def _render_csv(path: str, ft: str) -> str:
    import csv

    delimiter = "\t" if ft == "tsv" else ","
    parts: list[str] = ["<table>"]
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f, delimiter=delimiter)
        for i, row in enumerate(reader):
            if not any(c.strip() for c in row):
                continue
            tag = "th" if i == 0 else "td"
            parts.append("<tr>" + "".join(f"<{tag}>{_esc(c)}</{tag}>" for c in row) + "</tr>")
    parts.append("</table>")
    return _HTML_TEMPLATE.format(content="\n".join(parts))


def _render_docx(path: str) -> str:
    from docx import Document as DocxDocument

    doc = DocxDocument(path)
    parts: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if text:
            parts.append(f"<p>{_esc(text)}</p>")
    for table in doc.tables:
        parts.append("<table>")
        for ri, row in enumerate(table.rows):
            tag = "th" if ri == 0 else "td"
            cells = [cell.text.strip() for cell in row.cells]
            parts.append("<tr>" + "".join(f"<{tag}>{_esc(c)}</{tag}>" for c in cells) + "</tr>")
        parts.append("</table>")
    return _HTML_TEMPLATE.format(content="\n".join(parts))


def _esc(s: str) -> str:
    """Escape HTML special characters."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
