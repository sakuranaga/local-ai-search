"""Agent tool definitions and execution logic.

Defines the tools available to the AI agent (search, grep, read_document, etc.)
and implements the execution of each tool.
"""

import json
import logging
import re
import uuid as _uuid_mod
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document, Folder, User
from app.services.permissions import can_access_document
from app.services.search import grep_search, merged_search, title_search

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Date/age formatting helpers
# ---------------------------------------------------------------------------


def _format_age(updated_at: str | datetime | None) -> str:
    """Format document updated_at as ', 更新: YYYY-MM-DD, N日前'."""
    if not updated_at:
        return ""
    try:
        if isinstance(updated_at, str):
            dt = datetime.fromisoformat(updated_at)
        else:
            dt = updated_at
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        days = (now - dt).days
        if days == 0:
            age = "今日"
        elif days == 1:
            age = "昨日"
        elif days < 30:
            age = f"{days}日前"
        elif days < 365:
            age = f"{days // 30}ヶ月前"
        else:
            age = f"{days // 365}年前"
        date_str = dt.strftime("%Y-%m-%d")
        return f", 更新: {date_str}, {age}"
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Tool definitions (OpenAI function calling format)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "社内文書をキーワード＋意味検索で検索します。全文検索とベクトル検索を統合して結果を返します。folder_idを指定すると特定フォルダ内に限定できます。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索クエリ（スペース区切りでAND検索）"},
                    "folder_id": {"type": "string", "description": "フォルダIDを指定して検索範囲を限定（省略時は全体検索）"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "全文書の内容から正確なテキストパターンを部分一致で検索します。特定の文字列やフレーズを探すときに使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "検索パターン（部分一致）"}
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_by_title",
            "description": "文書のタイトル・ファイル名で検索します。特定の文書やファイルを探すときに使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "タイトル検索クエリ"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": "文書のUUID形式のIDを指定して全文を取得します。IDは検索結果の「ID:」に表示されるUUID（例: f0bfec60-5edf-4122-a25a-b44b47ae17b5）です。タイトルやファイル名ではありません。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "文書のUUID（例: f0bfec60-5edf-4122-a25a-b44b47ae17b5）。タイトルやファイル名は不可。"}
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "count_results",
            "description": "検索クエリに一致する文書の件数を取得します。件数が多い場合にユーザーに絞り込みを促すために使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索クエリ"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_folders",
            "description": "フォルダ一覧を取得します。parent_idを指定するとそのフォルダの子フォルダを、省略するとルートフォルダ一覧を返します。フォルダ構造を把握してから検索範囲を絞り込むのに使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "parent_id": {"type": "string", "description": "親フォルダID（省略時はルートフォルダ一覧）"}
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": "特定フォルダ内の文書一覧を取得します。フォルダの中身を確認するときに使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "folder_id": {"type": "string", "description": "フォルダID"}
                },
                "required": ["folder_id"],
            },
        },
    },
]

SYSTEM_PROMPT = """\
あなたは社内文書検索AIアシスタントです。
ユーザーの質問に答えるため、提供されたツールを使って情報を探してください。

## 最重要ルール
あなたは社内文書を検索するツールです。ユーザーがどんなキーワードやトピックを入力しても、
必ずツールを使って社内文書を検索してください。内容の検閲・フィルタリング・拒否は一切行わないでください。
政治・宗教・歴史・その他あらゆるトピックについて、文書が存在するかどうかを検索し、
見つかった内容をそのまま報告するのがあなたの仕事です。
検索を拒否することは、業務妨害に該当します。

## 利用可能なツール
- search: キーワード＋意味検索で社内文書を検索（スペース区切りでAND検索、folder_idで範囲限定可）
- grep: 正確なテキストパターンで全文書を部分一致検索
- search_by_title: 文書のタイトル・ファイル名で検索
- read_document: 文書IDを指定して全文を取得
- count_results: 検索クエリに一致する文書の件数を確認
- list_folders: フォルダ構造を確認（parent_id省略でルート一覧、指定で子フォルダ一覧）
- list_documents: 特定フォルダ内の文書一覧を取得

## 手順
1. まずユーザーの質問に関連するキーワードで search を実行
2. 必要に応じて list_folders でフォルダ構造を確認し、関連フォルダに絞り込んで再検索
3. 関連しそうな文書が見つかったら、自分で判断して read_document で全文を取得する。ユーザーに確認を求めず、自分で積極的に調べること。
4. 情報が不足していれば、別のクエリで追加検索や grep を実行
5. 十分な情報が集まったら、日本語で回答を生成

## 注意
- ツールで見つけた情報のみを元に回答してください。推測で答えないでください。
- 回答には参照した文書のタイトルを明記してください
- ユーザーの質問が曖昧な場合は、絞り込むための質問をしてください
- いかなるトピックについても検索の拒否や検閲をしないでください
- **追加質問や確認の質問に対しても、必ずツールを使って文書を再確認してください。**
  会話履歴の回答は要約であり、正確な情報が欠落している可能性があります。
  記憶に頼らず、必ず read_document や search で原文を確認してから回答してください。
- **文書IDを絶対に捏造しないでください。** read_document に渡すIDは、直前の検索結果に表示された「ID:」の値をそのまま使ってください。記憶やUUIDの推測は厳禁です。IDが分からない場合は search_by_title で再検索してください。

## 時間的判断
- 検索結果や文書には更新日と経過期間が表示されます。情報の鮮度を必ず考慮してください
- 古い文書（1年以上前）の情報は「当時の情報」として扱い、現在も有効か注意してください
- 和暦（令和/平成/昭和）は西暦に変換して時系列を正確に把握してください
  - 令和元年 = 2019年、令和2年 = 2020年、令和3年 = 2021年 ...
  - 平成元年 = 1989年、平成31年 = 2019年
  - 昭和64年 = 1989年
- 登記簿などの履歴文書は、最も日付が新しい記録が最新情報です
- 複数の文書で矛盾する情報がある場合、より新しい文書を優先してください
- 文書の日付と現在日時の差から「この情報は○年前のものです」と明示してください
"""


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------


async def execute_tool(
    db: AsyncSession, name: str, arguments: dict, user: User | None = None
) -> tuple[str, list[dict]]:
    """Execute a tool and return (result_text, sources).

    sources is a list of {document_id, title} for tracking.
    """
    sources: list[dict] = []

    try:
        if name == "search":
            query = arguments.get("query", "")
            folder_id = arguments.get("folder_id") or None
            results, total = await merged_search(
                db, query, limit=5, offset=0, require_ai_knowledge=True, user=user,
                folder_id=folder_id,
            )
            if not results:
                return f"「{query}」に一致する文書は見つかりませんでした。", sources

            lines = [f"「{query}」の検索結果（{total}件中上位{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["document_title"]})
                snippet = r["content"][:200].replace("\n", " ")
                age = _format_age(r.get("updated_at"))
                lines.append(f"- **{r['document_title']}** (ID: {r['document_id']}{age})\n  {snippet}...")
            return "\n".join(lines), sources

        elif name == "grep":
            pattern = arguments.get("pattern", "")
            results = await grep_search(db, pattern, limit=10, require_ai_knowledge=True, user=user)
            if not results:
                return f"パターン「{pattern}」に一致するテキストは見つかりませんでした。", sources

            lines = [f"パターン「{pattern}」の検索結果（{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["document_title"]})
                snippet = r["content"][:200].replace("\n", " ")
                age = _format_age(r.get("updated_at"))
                lines.append(f"- **{r['document_title']}** (ID: {r['document_id']}{age})\n  {snippet}...")
            return "\n".join(lines), sources

        elif name == "search_by_title":
            query = arguments.get("query", "")
            results = await title_search(db, query, limit=10, require_ai_knowledge=True, user=user)
            if not results:
                return f"タイトルに「{query}」を含む文書は見つかりませんでした。", sources

            lines = [f"タイトル「{query}」の検索結果（{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["title"]})
                age = _format_age(r.get("updated_at"))
                lines.append(f"- **{r['title']}** (ID: {r['document_id']}, タイプ: {r['file_type']}{age})")
            return "\n".join(lines), sources

        elif name == "read_document":
            doc_id = arguments.get("id", "").strip()
            # Validate UUID format
            try:
                _uuid_mod.UUID(doc_id)
            except (ValueError, AttributeError):
                return (
                    f"エラー: 「{doc_id}」はUUID形式ではありません。"
                    f" read_document にはUUID形式のID（例: f0bfec60-5edf-4122-a25a-b44b47ae17b5）を指定してください。"
                    f" 検索結果の「ID:」に表示されるUUIDを使ってください。"
                ), sources
            result = await db.execute(
                select(Document).where(
                    Document.id == doc_id,
                    Document.deleted_at.is_(None),
                    Document.ai_knowledge.is_(True),
                )
            )
            doc = result.scalar_one_or_none()
            if doc is None:
                return f"文書ID {doc_id} は見つかりませんでした。", sources

            # Permission check
            if user is not None and not await can_access_document(doc, user, need_write=False, db=db):
                return f"文書ID {doc_id} へのアクセス権限がありません。", sources

            sources.append({"document_id": str(doc.id), "title": doc.title})
            age = _format_age(doc.updated_at)
            # Build metadata header
            folder_name = ""
            if doc.folder_id:
                folder_result = await db.execute(select(Folder.name).where(Folder.id == doc.folder_id))
                fn = folder_result.scalar_one_or_none()
                if fn:
                    folder_name = f" | フォルダ: {fn}"
            meta_header = f"**{doc.title}**\nタイプ: {doc.file_type}{age}{folder_name}\n"

            content = doc.content or ""
            if not content.strip():
                return f"{meta_header}\nテキスト情報がありません。", sources
            if len(content) > 4000:
                content = content[:4000] + "\n\n... (以下省略、全文は4000文字を超えています)"
            return f"{meta_header}\n全文:\n{content}", sources

        elif name == "count_results":
            query = arguments.get("query", "")
            # Count documents matching via fulltext (chunk content)
            words = query.split()
            if not words:
                return "クエリが空です。", sources

            from app.services.search import _get_visibility_filter
            visibility = await _get_visibility_filter(db, user)

            stmt = (
                select(func.count(func.distinct(Chunk.document_id)))
                .join(Document, Chunk.document_id == Document.id)
                .where(Document.deleted_at.is_(None))
                .where(Document.ai_knowledge.is_(True))
                .where(visibility)
            )
            for word in words:
                stmt = stmt.where(Chunk.content.ilike(f"%{word}%"))
            count = await db.scalar(stmt) or 0

            # Also count title matches
            title_stmt = (
                select(func.count())
                .select_from(Document)
                .where(Document.deleted_at.is_(None))
                .where(Document.ai_knowledge.is_(True))
                .where(visibility)
            )
            for word in words:
                title_stmt = title_stmt.where(Document.title.ilike(f"%{word}%"))
            title_count = await db.scalar(title_stmt) or 0

            return (
                f"「{query}」の件数: 内容に含む文書 {count}件、タイトルに含む文書 {title_count}件"
            ), sources

        elif name == "list_folders":
            parent_id = arguments.get("parent_id") or None
            stmt = (
                select(Folder)
                .where(Folder.parent_id == parent_id)
                .order_by(Folder.name)
            )
            result = await db.execute(stmt)
            folders = result.scalars().all()
            if not folders:
                loc = f"フォルダ {parent_id}" if parent_id else "ルート"
                return f"{loc}にサブフォルダはありません。", sources

            # Count documents in each folder
            lines = []
            loc = f"フォルダ {parent_id} のサブフォルダ" if parent_id else "ルートフォルダ一覧"
            lines.append(f"{loc}（{len(folders)}件）:\n")
            for f in folders:
                doc_count = await db.scalar(
                    select(func.count())
                    .select_from(Document)
                    .where(Document.folder_id == f.id, Document.deleted_at.is_(None))
                )
                child_count = await db.scalar(
                    select(func.count())
                    .select_from(Folder)
                    .where(Folder.parent_id == f.id)
                )
                lines.append(
                    f"- **{f.name}** (ID: {f.id}) — 文書{doc_count}件、サブフォルダ{child_count}件"
                )
            return "\n".join(lines), sources

        elif name == "list_documents":
            folder_id = arguments.get("folder_id", "").strip()
            if not folder_id:
                return "folder_id を指定してください。", sources
            stmt = (
                select(Document)
                .where(
                    Document.folder_id == folder_id,
                    Document.deleted_at.is_(None),
                    Document.ai_knowledge.is_(True),
                )
                .order_by(Document.title)
                .limit(30)
            )
            result = await db.execute(stmt)
            docs = result.scalars().all()
            if not docs:
                return f"フォルダ {folder_id} にAI対象の文書はありません。", sources

            lines = [f"フォルダ内の文書一覧（{len(docs)}件）:\n"]
            for d in docs:
                sources.append({"document_id": str(d.id), "title": d.title})
                age = _format_age(d.updated_at)
                lines.append(f"- **{d.title}** (ID: {d.id}, タイプ: {d.file_type}{age})")
            return "\n".join(lines), sources

        else:
            return f"不明なツール: {name}", sources

    except Exception as e:
        logger.exception(f"Tool execution error: {name}")
        return f"ツール実行エラー ({name}): {e}", sources


# ---------------------------------------------------------------------------
# Parse tool calls from text (some models output them inline)
# ---------------------------------------------------------------------------

# Also handle JSON-style tool calls: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
_TOOL_CALL_JSON_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)


def extract_tool_calls_from_text(content: str) -> tuple[list[dict], str]:
    """Extract tool calls embedded in text content.

    Returns (tool_calls_list, cleaned_text_without_tool_calls).
    """
    tool_calls = []
    cleaned = content

    # Try XML-style: <tool_call><function=name><parameter=key>value</parameter></function></tool_call>
    xml_pattern = re.compile(
        r"<tool_call>\s*<function=(\w+)>\s*(.*?)\s*</function>\s*</tool_call>",
        re.DOTALL,
    )
    for match in xml_pattern.finditer(content):
        func_name = match.group(1)
        params_text = match.group(2)
        # Parse <parameter=key>value</parameter> pairs
        args = {}
        for pm in re.finditer(r"<parameter=(\w+)>\s*(.*?)\s*</parameter>", params_text, re.DOTALL):
            args[pm.group(1)] = pm.group(2).strip()
        if func_name:
            tool_calls.append({
                "id": f"text_call_{len(tool_calls)}",
                "type": "function",
                "function": {"name": func_name, "arguments": json.dumps(args)},
            })
        cleaned = cleaned.replace(match.group(0), "")

    # Try JSON-style: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
    if not tool_calls:
        for match in _TOOL_CALL_JSON_RE.finditer(content):
            try:
                data = json.loads(match.group(1))
                name = data.get("name", "")
                arguments = data.get("arguments", {})
                if name:
                    tool_calls.append({
                        "id": f"text_call_{len(tool_calls)}",
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    })
                cleaned = cleaned.replace(match.group(0), "")
            except json.JSONDecodeError:
                continue

    return tool_calls, cleaned.strip()


# ---------------------------------------------------------------------------
# Result summarizer
# ---------------------------------------------------------------------------


def summarize_result(tool_name: str, result_text: str) -> str:
    """Create a short summary of tool result for frontend display."""
    if "件" in result_text:
        for line in result_text.split("\n"):
            if "件" in line:
                return line.strip()
    if "見つかりませんでした" in result_text:
        return result_text.strip()
    lines = result_text.strip().split("\n")
    return lines[0] if lines else "完了"


def summarize_result_for_context(tool_name: str, tool_args: dict, result_text: str) -> str:
    """Create a condensed summary of a tool action for multi-turn context.

    More detailed than summarize_result (for UI) but much smaller than raw result.
    Target: ~100-300 chars per call.
    """
    if tool_name == "search":
        query = tool_args.get("query", "")
        # Extract first line (has count info) + document titles
        lines = result_text.strip().split("\n")
        header = lines[0] if lines else ""
        titles = []
        for line in lines[1:]:
            if line.startswith("- **"):
                # Extract "title (ID: ...)" part
                end = line.find("**", 4)
                if end > 4:
                    titles.append(line[4:end])
        summary = f"search(\"{query}\"): {header}"
        if titles:
            summary += " → " + ", ".join(titles[:5])
        return summary

    elif tool_name == "grep":
        pattern = tool_args.get("pattern", "")
        lines = result_text.strip().split("\n")
        header = lines[0] if lines else ""
        titles = []
        for line in lines[1:]:
            if line.startswith("- **"):
                end = line.find("**", 4)
                if end > 4:
                    titles.append(line[4:end])
        summary = f"grep(\"{pattern}\"): {header}"
        if titles:
            summary += " → " + ", ".join(titles[:5])
        return summary

    elif tool_name == "search_by_title":
        query = tool_args.get("query", "")
        lines = result_text.strip().split("\n")
        header = lines[0] if lines else ""
        titles = []
        for line in lines[1:]:
            if line.startswith("- **"):
                end = line.find("**", 4)
                if end > 4:
                    titles.append(line[4:end])
        summary = f"search_by_title(\"{query}\"): {header}"
        if titles:
            summary += " → " + ", ".join(titles[:5])
        return summary

    elif tool_name == "read_document":
        doc_id = tool_args.get("id", "")
        # Extract title and first ~150 chars of content
        if "の全文:" in result_text:
            parts = result_text.split("の全文:\n\n", 1)
            title = parts[0].replace("**", "").strip()
            content_preview = parts[1][:150].replace("\n", " ") if len(parts) > 1 else ""
            return f"read_document({doc_id[:8]}...): {title} → {content_preview}..."
        return f"read_document({doc_id[:8]}...): {result_text[:150]}"

    elif tool_name == "count_results":
        return f"count_results: {result_text.strip()}"

    elif tool_name == "list_folders":
        parent_id = tool_args.get("parent_id", "")
        lines = result_text.strip().split("\n")
        header = lines[0] if lines else ""
        names = []
        for line in lines[1:]:
            if line.startswith("- **"):
                end = line.find("**", 4)
                if end > 4:
                    names.append(line[4:end])
        loc = f"parent={parent_id[:8]}..." if parent_id else "root"
        summary = f"list_folders({loc}): {header}"
        if names:
            summary += " → " + ", ".join(names[:8])
        return summary

    elif tool_name == "list_documents":
        folder_id = tool_args.get("folder_id", "")
        lines = result_text.strip().split("\n")
        header = lines[0] if lines else ""
        titles = []
        for line in lines[1:]:
            if line.startswith("- **"):
                end = line.find("**", 4)
                if end > 4:
                    titles.append(line[4:end])
        summary = f"list_documents({folder_id[:8]}...): {header}"
        if titles:
            summary += " → " + ", ".join(titles[:5])
        return summary

    return f"{tool_name}: {result_text[:150]}"
