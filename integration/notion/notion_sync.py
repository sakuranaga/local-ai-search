#!/usr/bin/env python3
"""Notion to Local AI Search sync script.

Notion のページを再帰的に取得し、Markdown に変換して
Local AI Search (LAS) に同期する。
"""

import hashlib
import json
import os
import signal
import sys
import time
import logging
import requests
from pathlib import Path
from notion_client import Client as NotionClient
from notion_client.errors import APIResponseError
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LAS_BASE_URL = os.environ["LAS_BASE_URL"].rstrip("/")
LAS_API_KEY = os.environ["LAS_API_KEY"]

# Rate limit: Notion API は 3 req/s が目安
NOTION_REQUEST_INTERVAL = 0.35

# ポーリング間隔（秒）
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "300"))

# ハッシュ保存先
HASH_STORE_PATH = Path(os.environ.get("HASH_STORE_PATH", "/data/hashes.json"))


def load_sync_configs() -> list[dict]:
    """環境変数から NOTION_SYNC_<N>_* を読み込む。"""
    configs = []
    for i in range(1, 100):
        token = os.environ.get(f"NOTION_SYNC_{i}_TOKEN")
        if not token:
            break
        page_ids_raw = os.environ.get(f"NOTION_SYNC_{i}_PAGE_IDS", "")
        page_ids = [p.strip() for p in page_ids_raw.split(",") if p.strip()]
        if not page_ids:
            log.warning("NOTION_SYNC_%d_PAGE_IDS is empty, skipping", i)
            continue
        folder = os.environ.get(f"NOTION_SYNC_{i}_FOLDER", "Notion")
        configs.append({"token": token, "page_ids": page_ids, "folder": folder})
    return configs


# ---------------------------------------------------------------------------
# Notion -> Markdown conversion
# ---------------------------------------------------------------------------

class NotionToMarkdown:
    """Notion ブロックを Markdown に変換する。"""

    def __init__(self, notion: NotionClient):
        self.notion = notion

    # --- rich text ---

    @staticmethod
    def _rich_text(rich_text_list: list) -> str:
        parts = []
        for rt in rich_text_list:
            text = rt.get("plain_text", "")
            ann = rt.get("annotations", {})
            href = rt.get("href")

            if ann.get("code"):
                text = f"`{text}`"
            if ann.get("bold"):
                text = f"**{text}**"
            if ann.get("italic"):
                text = f"*{text}*"
            if ann.get("strikethrough"):
                text = f"~~{text}~~"
            if href:
                text = f"[{text}]({href})"

            parts.append(text)
        return "".join(parts)

    # --- block fetching (paginated) ---

    def _get_all_blocks(self, block_id: str) -> list:
        blocks = []
        cursor = None
        while True:
            time.sleep(NOTION_REQUEST_INTERVAL)
            resp = self.notion.blocks.children.list(
                block_id=block_id, start_cursor=cursor, page_size=100
            )
            blocks.extend(resp["results"])
            if not resp["has_more"]:
                break
            cursor = resp["next_cursor"]

        for block in blocks:
            if block.get("has_children") and block["type"] != "child_page":
                block["_children"] = self._get_all_blocks(block["id"])
        return blocks

    # --- conversion entry point ---

    def convert_page(self, page_id: str) -> str:
        blocks = self._get_all_blocks(page_id)
        return self._blocks_to_md(blocks, indent=0)

    def _blocks_to_md(self, blocks: list, indent: int) -> str:
        lines: list[str] = []
        for block in blocks:
            md = self._block_to_md(block, indent)
            if md is not None:
                lines.append(md)
        return "\n\n".join(lines)

    def _children_md(self, block: dict, indent: int) -> str:
        children = block.get("_children", [])
        if not children:
            return ""
        return "\n" + self._blocks_to_md(children, indent + 1)

    # --- individual block converters ---

    def _block_to_md(self, block: dict, indent: int) -> str | None:
        btype = block["type"]
        prefix = "  " * indent

        handler = getattr(self, f"_cvt_{btype}", None)
        if handler:
            return handler(block, prefix, indent)

        # フォールバック: rich_text を持つ未対応ブロック
        data = block.get(btype, {})
        if isinstance(data, dict) and "rich_text" in data:
            return prefix + self._rich_text(data["rich_text"])
        return None

    def _cvt_paragraph(self, block, prefix, indent):
        text = self._rich_text(block["paragraph"]["rich_text"])
        result = prefix + text
        return result + self._children_md(block, indent)

    def _cvt_heading_1(self, block, prefix, _indent):
        return f"# {self._rich_text(block['heading_1']['rich_text'])}"

    def _cvt_heading_2(self, block, prefix, _indent):
        return f"## {self._rich_text(block['heading_2']['rich_text'])}"

    def _cvt_heading_3(self, block, prefix, _indent):
        return f"### {self._rich_text(block['heading_3']['rich_text'])}"

    def _cvt_bulleted_list_item(self, block, prefix, indent):
        text = self._rich_text(block["bulleted_list_item"]["rich_text"])
        result = f"{prefix}- {text}"
        return result + self._children_md(block, indent)

    def _cvt_numbered_list_item(self, block, prefix, indent):
        text = self._rich_text(block["numbered_list_item"]["rich_text"])
        result = f"{prefix}1. {text}"
        return result + self._children_md(block, indent)

    def _cvt_to_do(self, block, prefix, indent):
        data = block["to_do"]
        checked = "x" if data.get("checked") else " "
        text = self._rich_text(data["rich_text"])
        result = f"{prefix}- [{checked}] {text}"
        return result + self._children_md(block, indent)

    def _cvt_toggle(self, block, prefix, indent):
        text = self._rich_text(block["toggle"]["rich_text"])
        result = f"{prefix}<details>\n{prefix}<summary>{text}</summary>\n"
        result += self._children_md(block, indent)
        result += f"\n{prefix}</details>"
        return result

    def _cvt_code(self, block, prefix, _indent):
        data = block["code"]
        lang = data.get("language", "")
        code = self._rich_text(data["rich_text"])
        return f"```{lang}\n{code}\n```"

    def _cvt_quote(self, block, prefix, indent):
        text = self._rich_text(block["quote"]["rich_text"])
        lines = text.split("\n")
        result = "\n".join(f"{prefix}> {line}" for line in lines)
        return result + self._children_md(block, indent)

    def _cvt_callout(self, block, prefix, indent):
        data = block["callout"]
        icon = ""
        if data.get("icon"):
            if data["icon"]["type"] == "emoji":
                icon = data["icon"]["emoji"] + " "
        text = self._rich_text(data["rich_text"])
        result = f"{prefix}> {icon}{text}"
        return result + self._children_md(block, indent)

    def _cvt_divider(self, block, prefix, _indent):
        return "---"

    def _cvt_image(self, block, prefix, _indent):
        data = block["image"]
        url = ""
        if data["type"] == "file":
            url = data["file"]["url"]
        elif data["type"] == "external":
            url = data["external"]["url"]
        caption = self._rich_text(data.get("caption", []))
        alt = caption or "image"
        return f"{prefix}![{alt}]({url})"

    def _cvt_bookmark(self, block, prefix, _indent):
        url = block["bookmark"].get("url", "")
        caption = self._rich_text(block["bookmark"].get("caption", []))
        label = caption or url
        return f"{prefix}[{label}]({url})"

    def _cvt_embed(self, block, prefix, _indent):
        url = block["embed"].get("url", "")
        return f"{prefix}[Embed]({url})"

    def _cvt_video(self, block, prefix, _indent):
        data = block["video"]
        url = ""
        if data["type"] == "file":
            url = data["file"]["url"]
        elif data["type"] == "external":
            url = data["external"]["url"]
        return f"{prefix}[Video]({url})"

    def _cvt_table(self, block, prefix, indent):
        children = block.get("_children", [])
        if not children:
            return None
        rows = []
        for row_block in children:
            if row_block["type"] != "table_row":
                continue
            cells = row_block["table_row"]["cells"]
            row = [self._rich_text(cell) for cell in cells]
            rows.append(row)
        if not rows:
            return None
        # build markdown table
        header = "| " + " | ".join(rows[0]) + " |"
        sep = "| " + " | ".join("---" for _ in rows[0]) + " |"
        body_lines = []
        for row in rows[1:]:
            body_lines.append("| " + " | ".join(row) + " |")
        return "\n".join([header, sep] + body_lines)

    def _cvt_table_row(self, block, prefix, _indent):
        return None  # handled by _cvt_table

    def _cvt_child_page(self, block, prefix, _indent):
        return None  # handled separately in recursive crawl

    def _cvt_child_database(self, block, prefix, _indent):
        return None

    def _cvt_column_list(self, block, prefix, indent):
        return self._children_md(block, indent).lstrip("\n")

    def _cvt_column(self, block, prefix, indent):
        return self._children_md(block, indent).lstrip("\n")

    def _cvt_equation(self, block, prefix, _indent):
        expr = block["equation"].get("expression", "")
        return f"{prefix}$$\n{expr}\n$$"

    def _cvt_synced_block(self, block, prefix, indent):
        return self._children_md(block, indent).lstrip("\n")


# ---------------------------------------------------------------------------
# Recursive page crawler
# ---------------------------------------------------------------------------

class NotionCrawler:
    """起点ページから子ページを再帰的に取得する。"""

    def __init__(self, notion: NotionClient, converter: NotionToMarkdown):
        self.notion = notion
        self.converter = converter

    def get_page_title(self, page_id: str) -> str:
        time.sleep(NOTION_REQUEST_INTERVAL)
        page = self.notion.pages.retrieve(page_id=page_id)
        props = page.get("properties", {})

        # title プロパティを探す
        for prop in props.values():
            if prop.get("type") == "title":
                return self._rich_text_plain(prop.get("title", []))

        # フォールバック: child_page ブロックのタイトル
        return page_id

    @staticmethod
    def _rich_text_plain(rich_text_list: list) -> str:
        return "".join(rt.get("plain_text", "") for rt in rich_text_list)

    def get_page_url(self, page_id: str) -> str:
        clean_id = page_id.replace("-", "")
        return f"https://notion.so/{clean_id}"

    def crawl(self, page_id: str, folder_base: str) -> list[dict]:
        """再帰的にページを取得。各ページを dict で返す。"""
        pages = []
        self._crawl_recursive(page_id, folder_base, pages, depth=0)
        return pages

    def _crawl_recursive(
        self, page_id: str, folder_path: str, pages: list, depth: int
    ):
        title = self.get_page_title(page_id)
        log.info("%s crawling: %s (depth=%d)", "  " * depth, title, depth)

        # ページ本体を Markdown に変換
        content = self.converter.convert_page(page_id)

        pages.append(
            {
                "id": page_id,
                "title": title,
                "content": content,
                "url": self.get_page_url(page_id),
                "folder": folder_path,
            }
        )

        # 子ページを探す
        child_page_ids = self._find_child_pages(page_id)
        child_folder = f"{folder_path}/{title}"
        for child_id in child_page_ids:
            self._crawl_recursive(child_id, child_folder, pages, depth + 1)

    def _find_child_pages(self, block_id: str) -> list[str]:
        """ブロックの直接の子から child_page を抽出する。"""
        child_ids = []
        cursor = None
        while True:
            time.sleep(NOTION_REQUEST_INTERVAL)
            resp = self.notion.blocks.children.list(
                block_id=block_id, start_cursor=cursor, page_size=100
            )
            for block in resp["results"]:
                if block["type"] == "child_page":
                    child_ids.append(block["id"])
            if not resp["has_more"]:
                break
            cursor = resp["next_cursor"]
        return child_ids


# ---------------------------------------------------------------------------
# Hash store (変更検知用)
# ---------------------------------------------------------------------------

class HashStore:
    """ページごとの MD コンテンツハッシュを JSON ファイルに保存する。"""

    def __init__(self, path: Path):
        self.path = path
        self.hashes: dict[str, str] = {}
        self._load()

    def _load(self):
        if self.path.exists():
            self.hashes = json.loads(self.path.read_text())

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.hashes, indent=2))

    @staticmethod
    def _compute_hash(content: str) -> str:
        return hashlib.sha256(content.encode()).hexdigest()

    def has_changed(self, page_id: str, content: str) -> bool:
        """コンテンツが前回と異なるか判定する。"""
        new_hash = self._compute_hash(content)
        return self.hashes.get(page_id) != new_hash

    def update(self, page_id: str, content: str):
        """ハッシュを更新して保存する。"""
        self.hashes[page_id] = self._compute_hash(content)
        self._save()


# ---------------------------------------------------------------------------
# LAS client
# ---------------------------------------------------------------------------

class LASClient:
    """Local AI Search API client."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
        )

    def ingest(self, page: dict) -> dict:
        payload = {
            "title": page["title"],
            "content": page["content"],
            "source": "notion",
            "external_id": page["id"],
            "external_url": page["url"],
            "folder": page["folder"],
            "version": True,
        }
        resp = self.session.post(
            f"{self.base_url}/api/ingest/content", json=payload
        )
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Sync cycle
# ---------------------------------------------------------------------------

def sync_once(configs: list[dict], las: LASClient, hash_store: HashStore) -> tuple[int, int, int]:
    """1回の同期サイクルを実行。(synced, skipped, errors) を返す。"""
    total_synced = 0
    total_skipped = 0
    total_errors = 0

    for i, cfg in enumerate(configs, 1):
        log.info("=== Sync config %d: %d root page(s) -> %s ===", i, len(cfg["page_ids"]), cfg["folder"])
        notion = NotionClient(auth=cfg["token"])
        converter = NotionToMarkdown(notion)
        crawler = NotionCrawler(notion, converter)

        for page_id in cfg["page_ids"]:
            try:
                pages = crawler.crawl(page_id, cfg["folder"])
                log.info("Found %d page(s) under %s", len(pages), page_id)

                for page in pages:
                    if not hash_store.has_changed(page["id"], page["content"]):
                        total_skipped += 1
                        continue

                    try:
                        result = las.ingest(page)
                        hash_store.update(page["id"], page["content"])
                        action = "created" if result.get("created") else "updated"
                        log.info("  %s: %s (%s)", action, page["title"], result["id"])
                        total_synced += 1
                    except requests.HTTPError as e:
                        log.error("  Failed to ingest '%s': %s", page["title"], e)
                        total_errors += 1

            except APIResponseError as e:
                log.error("Notion API error for page %s: %s", page_id, e)
                total_errors += 1

    return total_synced, total_skipped, total_errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    log.info("Received signal %d, shutting down after current cycle...", signum)
    _shutdown = True


def main():
    configs = load_sync_configs()
    if not configs:
        log.error("No NOTION_SYNC_* configs found in environment. See .env.example")
        sys.exit(1)

    las = LASClient(LAS_BASE_URL, LAS_API_KEY)
    hash_store = HashStore(HASH_STORE_PATH)

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    log.info("Starting Notion sync (poll interval: %ds)", POLL_INTERVAL)

    while not _shutdown:
        synced, skipped, errors = sync_once(configs, las, hash_store)
        log.info(
            "Cycle done: %d synced, %d unchanged (skipped), %d errors",
            synced, skipped, errors,
        )

        # 次のサイクルまで待機（1秒刻みで shutdown チェック）
        for _ in range(POLL_INTERVAL):
            if _shutdown:
                break
            time.sleep(1)

    log.info("Shutdown complete.")


if __name__ == "__main__":
    main()
