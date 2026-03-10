"""AI autonomous search agent using ReAct-style tool calling.

The agent iteratively calls tools (search, grep, read_document, search_by_title)
to find information, then generates a final answer with streaming.
"""

import json
import logging
import re
from typing import AsyncIterator

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Document
from app.services.llm import chat_completion, stream_chat_raw
from app.services.search import grep_search, merged_search, title_search
from app.services.settings import get_setting

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tool definitions (OpenAI function calling format)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "社内文書をキーワード＋意味検索で検索します。全文検索とベクトル検索を統合して結果を返します。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索クエリ（スペース区切りでAND検索）"}
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
            "description": "文書IDを指定して全文を取得します。検索結果で見つかった文書の詳細を読むときに使います。",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "文書ID (UUID)"}
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
]

SYSTEM_PROMPT = """\
あなたは社内文書検索AIアシスタントです。
ユーザーの質問に答えるため、提供されたツールを使って情報を探してください。

## 利用可能なツール
- search: キーワード＋意味検索で社内文書を検索（スペース区切りでAND検索）
- grep: 正確なテキストパターンで全文書を部分一致検索
- search_by_title: 文書のタイトル・ファイル名で検索
- read_document: 文書IDを指定して全文を取得
- count_results: 検索クエリに一致する文書の件数を確認

## 手順
1. まずユーザーの質問に関連するキーワードで search や count_results を実行して概要を把握
2. 件数が多すぎる場合はユーザーにどの情報を探しているか聞いてください
3. 情報が不足していれば、別のクエリで追加検索や grep を実行
4. 特定の文書の詳細が必要なら read_document で全文を取得
5. 十分な情報が集まったら、日本語で回答を生成

## 注意
- ツールで見つけた情報のみを元に回答してください。推測で答えないでください。
- 回答には参照した文書のタイトルを明記してください
- ユーザーの質問が曖昧な場合は、絞り込むための質問をしてください
"""


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------


async def _execute_tool(
    db: AsyncSession, name: str, arguments: dict
) -> tuple[str, list[dict]]:
    """Execute a tool and return (result_text, sources).

    sources is a list of {document_id, title} for tracking.
    """
    sources: list[dict] = []

    try:
        if name == "search":
            query = arguments.get("query", "")
            results, total = await merged_search(
                db, query, limit=5, offset=0, require_ai_knowledge=True
            )
            if not results:
                return f"「{query}」に一致する文書は見つかりませんでした。", sources

            lines = [f"「{query}」の検索結果（{total}件中上位{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["document_title"]})
                snippet = r["content"][:200].replace("\n", " ")
                lines.append(f"- **{r['document_title']}** (ID: {r['document_id']})\n  {snippet}...")
            return "\n".join(lines), sources

        elif name == "grep":
            pattern = arguments.get("pattern", "")
            results = await grep_search(db, pattern, limit=10, require_ai_knowledge=True)
            if not results:
                return f"パターン「{pattern}」に一致するテキストは見つかりませんでした。", sources

            lines = [f"パターン「{pattern}」の検索結果（{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["document_title"]})
                snippet = r["content"][:200].replace("\n", " ")
                lines.append(f"- **{r['document_title']}** (ID: {r['document_id']})\n  {snippet}...")
            return "\n".join(lines), sources

        elif name == "search_by_title":
            query = arguments.get("query", "")
            results = await title_search(db, query, limit=10, require_ai_knowledge=True)
            if not results:
                return f"タイトルに「{query}」を含む文書は見つかりませんでした。", sources

            lines = [f"タイトル「{query}」の検索結果（{len(results)}件）:\n"]
            for r in results:
                sources.append({"document_id": r["document_id"], "title": r["title"]})
                lines.append(f"- **{r['title']}** (ID: {r['document_id']}, タイプ: {r['file_type']})")
            return "\n".join(lines), sources

        elif name == "read_document":
            doc_id = arguments.get("id", "")
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

            sources.append({"document_id": str(doc.id), "title": doc.title})
            content = doc.content
            if len(content) > 4000:
                content = content[:4000] + "\n\n... (以下省略、全文は4000文字を超えています)"
            return f"**{doc.title}** の全文:\n\n{content}", sources

        elif name == "count_results":
            query = arguments.get("query", "")
            # Count documents matching via fulltext (chunk content)
            words = query.split()
            if not words:
                return "クエリが空です。", sources
            stmt = (
                select(func.count(func.distinct(Chunk.document_id)))
                .join(Document, Chunk.document_id == Document.id)
                .where(Document.deleted_at.is_(None))
                .where(Document.ai_knowledge.is_(True))
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
            )
            for word in words:
                title_stmt = title_stmt.where(Document.title.ilike(f"%{word}%"))
            title_count = await db.scalar(title_stmt) or 0

            return (
                f"「{query}」の件数: 内容に含む文書 {count}件、タイトルに含む文書 {title_count}件"
            ), sources

        else:
            return f"不明なツール: {name}", sources

    except Exception as e:
        logger.exception(f"Tool execution error: {name}")
        return f"ツール実行エラー ({name}): {e}", sources


# ---------------------------------------------------------------------------
# Parse tool calls from text (some models output them inline)
# ---------------------------------------------------------------------------

# Pattern: <tool_call> ... </tool_call> with JSON or XML-style params inside
_TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*(?:<function=(\w+)>\s*<parameter=(\w+)>\s*(.*?)\s*</parameter>\s*</function>|"
    r"\{.*?\})\s*</tool_call>",
    re.DOTALL,
)

# Also handle JSON-style tool calls: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
_TOOL_CALL_JSON_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)


def _extract_tool_calls_from_text(content: str) -> tuple[list[dict], str]:
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
# Agent loop
# ---------------------------------------------------------------------------


async def run_agent(
    db: AsyncSession,
    messages: list[dict],
    existing_context: list[str] | None = None,
) -> AsyncIterator[dict]:
    """Run the ReAct agent loop.

    Yields SSE event dicts:
      - {"type": "tool_call", "round": N, "name": "...", "arguments": {...}}
      - {"type": "tool_result", "round": N, "name": "...", "summary": "..."}
      - {"type": "token", "content": "..."}
      - {"type": "sources", "sources": [...]}
      - {"type": "done"}
    """
    max_rounds = int(await get_setting(db, "ai_max_search_rounds") or "3")
    all_sources: list[dict] = []
    seen_doc_ids: set[str] = set()

    # Build conversation with system prompt
    system_content = SYSTEM_PROMPT
    if existing_context:
        context_text = "\n\n---\n\n".join(existing_context)
        system_content += f"\n\n## 前回の検索で取得済みのコンテキスト:\n{context_text}"

    conv_messages = [{"role": "system", "content": system_content}] + messages

    for round_num in range(1, max_rounds + 1):
        is_last_round = round_num == max_rounds

        # Call LLM (non-streaming for tool rounds)
        response = await chat_completion(
            conv_messages,
            tools=None if is_last_round else TOOLS,
        )

        choices = response.get("choices", [])
        if not choices:
            logger.warning("LLM returned empty choices in round %d", round_num)
            break
        choice = choices[0]
        message = choice.get("message", {})
        finish_reason = choice.get("finish_reason", "stop")
        logger.debug("Round %d: finish_reason=%s, has_content=%s, has_tool_calls=%s",
                      round_num, finish_reason, bool(message.get("content")),
                      bool(message.get("tool_calls")))

        # Check for tool calls (structured or embedded in text)
        tool_calls = message.get("tool_calls")
        content = message.get("content", "")

        # Some models embed tool calls in text instead of using tool_calls field
        if not tool_calls and content and "<tool_call>" in content:
            text_tool_calls, cleaned_content = _extract_tool_calls_from_text(content)
            if text_tool_calls:
                tool_calls = text_tool_calls
                content = cleaned_content
                message = {**message, "content": content, "tool_calls": tool_calls}

        if not tool_calls or finish_reason == "stop":
            # No tool calls — this is the final answer
            if content:
                conv_messages.append({"role": "assistant", "content": content})
                for token in _chunk_text_for_streaming(content):
                    yield {"type": "token", "content": token}
                break

            # LLM returned empty content after tool rounds — force final answer
            if round_num > 1:
                logger.warning("LLM returned empty content after tool rounds, forcing final answer")
                conv_messages.append({
                    "role": "user",
                    "content": "これまでに収集した情報を元に、ユーザーの質問に回答してください。",
                })
                async for token in stream_chat_raw(conv_messages):
                    yield {"type": "token", "content": token}
            break

        # Append the assistant message with tool calls to conversation
        conv_messages.append(message)

        # Execute each tool call
        for tc in tool_calls:
            func_info = tc.get("function", {})
            tool_name = func_info.get("name", "")
            try:
                tool_args = json.loads(func_info.get("arguments", "{}"))
            except json.JSONDecodeError:
                tool_args = {}

            tc_id = tc.get("id", f"call_{round_num}")

            # Notify frontend about tool call
            yield {
                "type": "tool_call",
                "round": round_num,
                "name": tool_name,
                "arguments": tool_args,
            }

            # Execute the tool
            result_text, sources = await _execute_tool(db, tool_name, tool_args)

            # Track sources
            for s in sources:
                if s["document_id"] not in seen_doc_ids:
                    seen_doc_ids.add(s["document_id"])
                    all_sources.append(s)

            # Notify frontend about result
            yield {
                "type": "tool_result",
                "round": round_num,
                "name": tool_name,
                "summary": _summarize_result(tool_name, result_text),
            }

            # Append tool result to conversation
            conv_messages.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": result_text,
            })

    else:
        # max_rounds exhausted without a text response — force final answer
        conv_messages.append({
            "role": "user",
            "content": "これまでに収集した情報を元に、ユーザーの質問に回答してください。",
        })
        async for token in stream_chat_raw(conv_messages):
            yield {"type": "token", "content": token}

    # Send sources
    if all_sources:
        yield {"type": "sources", "sources": all_sources}

    yield {"type": "done"}


def _chunk_text_for_streaming(text: str, chunk_size: int = 4) -> list[str]:
    """Split text into small chunks to simulate streaming."""
    chunks = []
    for i in range(0, len(text), chunk_size):
        chunks.append(text[i : i + chunk_size])
    return chunks


def _summarize_result(tool_name: str, result_text: str) -> str:
    """Create a short summary of tool result for frontend display."""
    # Extract count info from result text
    if "件" in result_text:
        for line in result_text.split("\n"):
            if "件" in line:
                return line.strip()
    if "見つかりませんでした" in result_text:
        return result_text.strip()
    lines = result_text.strip().split("\n")
    return lines[0] if lines else "完了"
