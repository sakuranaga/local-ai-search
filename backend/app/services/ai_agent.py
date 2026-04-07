"""AI autonomous search agent v2 using ReAct-style tool calling.

The agent iteratively calls tools (search, grep, read_document, search_by_title)
to find information, then generates a final answer with streaming.

v2 changes:
- 3-stage intent classification (search/context/direct)
- Working memory (tracks searched queries, read documents)
- force_search flag for search-form queries
- Query reconstruction instead of forced raw-query search
- Cleaner agent loop
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models import Folder, User
from app.services.agent_tools import (
    SYSTEM_PROMPT,
    TOOLS,
    execute_tool,
    extract_tool_calls_from_text,
    summarize_result,
    summarize_result_for_context,
)
from app.services.compaction import compact_messages, should_compact
from app.services.llm import CancelledByClient, chat_completion, stream_chat_raw
from app.services.settings import get_setting

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Working memory
# ---------------------------------------------------------------------------


@dataclass
class WorkingMemory:
    """Tracks what the agent has done in this turn."""

    searched_queries: list[str] = field(default_factory=list)
    read_documents: list[dict] = field(default_factory=list)  # {id, title, summary}

    def to_prompt_section(self) -> str:
        """Format as a system prompt section."""
        if not self.searched_queries and not self.read_documents:
            return ""
        lines = ["## ワーキングメモリ（今回のセッションで取得済みの情報）"]
        if self.searched_queries:
            lines.append(f"検索済みクエリ: {', '.join(self.searched_queries[-5:])}")
        if self.read_documents:
            lines.append("読み込み済み文書:")
            for doc in self.read_documents[-10:]:
                lines.append(f"  - {doc['title']} (ID: {doc['id']})")
                if doc.get("summary"):
                    lines.append(f"    要旨: {doc['summary'][:100]}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Streaming with tool_call XML filtering
# ---------------------------------------------------------------------------


async def _stream_filtered(
    messages: list[dict],
    cancel_event: asyncio.Event | None = None,
) -> AsyncIterator[dict]:
    """Stream chat and filter out any <tool_call> XML from output."""
    _TAG_OPEN = "<tool_call>"
    _TAG_CLOSE = "</tool_call>"
    buffer = ""
    async for token in stream_chat_raw(messages, cancel_event=cancel_event):
        buffer += token
        while buffer:
            tag_start = buffer.find(_TAG_OPEN)
            if tag_start == -1:
                # Check if buffer ends with a partial prefix of "<tool_call>"
                hold = 0
                for i in range(min(len(_TAG_OPEN), len(buffer)), 1, -1):
                    if buffer.endswith(_TAG_OPEN[:i]) and i >= 2:
                        hold = i
                        break
                emit_end = len(buffer) - hold
                if emit_end > 0:
                    yield {"type": "token", "content": buffer[:emit_end]}
                buffer = buffer[emit_end:]
                break
            else:
                # Emit text before the tag
                if tag_start > 0:
                    yield {"type": "token", "content": buffer[:tag_start]}
                # Look for closing tag
                tag_end = buffer.find(_TAG_CLOSE, tag_start)
                if tag_end != -1:
                    buffer = buffer[tag_end + len(_TAG_CLOSE) :]
                else:
                    buffer = buffer[tag_start:]
                    break
    # Flush remaining buffer (strip any unclosed tool_call)
    if buffer:
        cleaned = re.sub(r"<tool_call>.*", "", buffer, flags=re.DOTALL).strip()
        if cleaned:
            yield {"type": "token", "content": cleaned}


# ---------------------------------------------------------------------------
# Folder tree for system prompt
# ---------------------------------------------------------------------------


async def _build_folder_tree(db: AsyncSession) -> str:
    """Build a concise folder tree string for the system prompt."""
    result = await db.execute(
        select(Folder).options(selectinload(Folder.children)).order_by(Folder.name)
    )
    all_folders = result.scalars().all()
    if not all_folders:
        return ""

    # Build lookup: parent_id -> list of folders
    by_parent: dict[str | None, list] = {}
    for f in all_folders:
        pid = str(f.parent_id) if f.parent_id else None
        by_parent.setdefault(pid, []).append(f)

    lines: list[str] = []

    def _walk(parent_id: str | None, indent: int) -> None:
        children = by_parent.get(parent_id, [])
        for f in children:
            fid = str(f.id)
            prefix = "  " * indent
            lines.append(f"{prefix}- {f.name} (ID: {fid})")
            _walk(fid, indent + 1)

    _walk(None, 0)
    # Cap at ~2000 chars to avoid bloating prompt
    tree = "\n".join(lines)
    if len(tree) > 2000:
        tree = tree[:2000] + "\n  ... (省略)"
    return tree


# ---------------------------------------------------------------------------
# Query intent classification (3-stage)
# ---------------------------------------------------------------------------

_INTENT_SYSTEM_PROMPT = """\
ユーザーの最新の質問を、会話の文脈を考慮して分類してください。

分類:
- search: 新たな社内文書の検索が必要（まだ調べていない情報を探す、新しい文書を確認する）
- context: 会話中に既にある情報で回答可能（要約、分析、言い換え、前の回答への深掘り）
- direct: 検索も既存情報も不要（雑談、時刻の質問、挨拶、操作方法、会話自体への感想やメタ質問）

「search」「context」「direct」のいずれかのみを出力してください。"""


async def _classify_intent(
    messages: list[dict],
    cancel_event: asyncio.Event | None = None,
) -> str:
    """Classify user query intent as 'search', 'context', or 'direct'.

    Uses a lightweight LLM call with minimal context.
    Returns 'search' on any failure (safe default).
    """
    # Extract latest user query
    user_query = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            user_query = m.get("content", "")
            break
    if not user_query:
        return "search"

    # Build minimal context: last few messages for conversation awareness
    context_msgs = []
    non_system = [m for m in messages if m.get("role") != "system"]
    recent = non_system[-6:]  # Last 3 pairs max
    for m in recent:
        role = m.get("role", "")
        content = m.get("content", "")
        turn_ctx = m.get("turn_context", "")
        # Truncate to keep classification fast
        if len(content) > 200:
            content = content[:200] + "..."
        line = f"{role}: {content}"
        if turn_ctx:
            tc_short = turn_ctx[:100] + "..." if len(turn_ctx) > 100 else turn_ctx
            line += f"\n[ツール使用: {tc_short}]"
        context_msgs.append(line)

    classify_messages = [
        {"role": "system", "content": _INTENT_SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(context_msgs)},
    ]

    try:
        response = await chat_completion(
            classify_messages,
            cancel_event=cancel_event,
        )
        choice = response.get("choices", [{}])[0]
        result = choice.get("message", {}).get("content", "").strip().lower()
        if result in ("search", "context", "direct"):
            logger.info(
                "Intent classification: %s (query: %s)", result, user_query[:80]
            )
            return result
        # If model returned something unexpected, default to search
        logger.warning(
            "Unexpected intent classification: %r, defaulting to search", result
        )
        return "search"
    except CancelledByClient:
        raise
    except Exception:
        logger.exception("Intent classification failed, defaulting to search")
        return "search"


# ---------------------------------------------------------------------------
# Conversation message builder
# ---------------------------------------------------------------------------


def _build_conv_messages(
    system_content: str, messages: list[dict]
) -> list[dict]:
    """Build the conv_messages list from system prompt and user messages."""
    conv_messages = [{"role": "system", "content": system_content}]

    for m in messages:
        created_at = m.get("created_at", "")
        time_prefix = f"[{created_at}] " if created_at else ""

        if m.get("turn_context") and m.get("role") == "assistant":
            augmented = (
                f"{time_prefix}[前回のツール使用結果]\n{m['turn_context']}\n\n"
                f"[回答]\n{m['content']}"
            )
            conv_messages.append({"role": "assistant", "content": augmented})
        elif m.get("role") == "user" and time_prefix:
            conv_messages.append(
                {"role": "user", "content": f"{time_prefix}{m['content']}"}
            )
        else:
            conv_messages.append({"role": m["role"], "content": m["content"]})

    return conv_messages


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


async def run_agent(
    db: AsyncSession,
    messages: list[dict],
    existing_context: list[str] | None = None,
    user: User | None = None,
    cancel_event: asyncio.Event | None = None,
    force_search: bool = False,
) -> AsyncIterator[dict]:
    """Run the ReAct agent loop.

    Yields SSE event dicts:
      - {"type": "intent", "intent": "search|context|direct"}
      - {"type": "tool_call", "round": N, "name": "...", "arguments": {...}}
      - {"type": "tool_result", "round": N, "name": "...", "summary": "..."}
      - {"type": "token", "content": "..."}
      - {"type": "sources", "sources": [...]}
      - {"type": "turn_context", "summary": "..."}
      - {"type": "done"}
    """
    max_rounds = int(await get_setting(db, "ai_max_search_rounds") or "10")
    all_sources: list[dict] = []
    seen_doc_ids: set[str] = set()
    tool_actions: list[str] = []  # Condensed summaries for turn_context
    memory = WorkingMemory()

    # -----------------------------------------------------------------------
    # Build system prompt
    # -----------------------------------------------------------------------
    system_content = SYSTEM_PROMPT

    # Inject current datetime (JST)
    JST = timezone(timedelta(hours=9))
    now = datetime.now(JST)
    weekdays = ["月", "火", "水", "木", "金", "土", "日"]
    date_str = now.strftime(f"%Y年%-m月%-d日({weekdays[now.weekday()]}) %H:%M JST")
    system_content += f"\n\n## 現在日時\n{date_str}\n"

    # Inject folder tree
    folder_tree = await _build_folder_tree(db)
    if folder_tree:
        system_content += (
            f"\n\n## フォルダ構造\n"
            f"以下のフォルダが存在します。検索時にfolder_idで範囲を絞り込んだり、"
            f"list_documentsでフォルダ内の文書を確認できます。\n{folder_tree}"
        )

    # Inject existing context from previous turns
    if existing_context:
        context_text = "\n\n---\n\n".join(existing_context)
        system_content += (
            f"\n\n## 前回の検索で取得済みのコンテキスト:\n{context_text}"
        )

    # -----------------------------------------------------------------------
    # Build conversation messages
    # -----------------------------------------------------------------------
    conv_messages = _build_conv_messages(system_content, messages)

    # -----------------------------------------------------------------------
    # Conversation compaction
    # -----------------------------------------------------------------------
    if should_compact(conv_messages):
        pre_count = len(conv_messages)
        conv_messages = compact_messages(conv_messages)
        logger.info(
            "Compacted conversation: %d -> %d messages", pre_count, len(conv_messages)
        )

    # -----------------------------------------------------------------------
    # Intent classification
    # -----------------------------------------------------------------------
    if force_search:
        intent = "search"
        logger.info("Force search: skipping intent classification")
    else:
        intent = await _classify_intent(messages, cancel_event=cancel_event)
    yield {"type": "intent", "intent": intent}

    # -----------------------------------------------------------------------
    # Direct / Context path — skip agent loop
    # -----------------------------------------------------------------------
    if intent in ("direct", "context"):
        logger.info("%s intent: streaming answer without tools", intent.title())
        async for evt in _stream_filtered(conv_messages, cancel_event=cancel_event):
            yield evt
        yield {"type": "done"}
        return

    # -----------------------------------------------------------------------
    # Search path — ReAct agent loop
    # -----------------------------------------------------------------------
    answer_generated = False
    for round_num in range(1, max_rounds + 1):
        if cancel_event and cancel_event.is_set():
            raise CancelledByClient()

        try:
            # Update system prompt with working memory (after round 1+)
            memory_section = memory.to_prompt_section()
            if memory_section and conv_messages and conv_messages[0]["role"] == "system":
                base = system_content
                conv_messages[0] = {"role": "system", "content": f"{base}\n\n{memory_section}"}

            is_last_round = round_num == max_rounds

            # Call LLM — use tools only if not the last round
            response = await chat_completion(
                conv_messages,
                tools=None if is_last_round else TOOLS,
                cancel_event=cancel_event,
            )

            choices = response.get("choices", [])
            if not choices:
                logger.warning("LLM returned empty choices in round %d", round_num)
                break
            choice = choices[0]
            message = choice.get("message", {})
            finish_reason = choice.get("finish_reason", "stop")
            logger.info(
                "Round %d: finish_reason=%s, has_content=%s, has_tool_calls=%s",
                round_num,
                finish_reason,
                bool(message.get("content")),
                bool(message.get("tool_calls")),
            )

            # Check for tool calls (structured or embedded in text)
            tool_calls = message.get("tool_calls")
            content = message.get("content", "")

            # Some models embed tool calls in text instead of using tool_calls field.
            # Only extract if LLM explicitly wants to continue (finish_reason != stop)
            # OR if it's the first round (need at least one search).
            # When finish_reason=stop after multiple rounds, the LLM intends to
            # finish — extracting embedded tool calls causes the stream to hang.
            should_extract = (
                not tool_calls
                and content
                and "<tool_call>" in content
                and (finish_reason != "stop" or round_num <= 1)
            )
            if should_extract:
                text_tool_calls, cleaned_content = extract_tool_calls_from_text(content)
                if text_tool_calls:
                    logger.info(
                        "Round %d: Extracted %d tool calls from text",
                        round_num,
                        len(text_tool_calls),
                    )
                    tool_calls = text_tool_calls
                    content = cleaned_content
                    # Build a clean message dict — only include fields the LLM API
                    # expects, to avoid issues when sending conv_messages back
                    message = {
                        "role": "assistant",
                        "content": content,
                        "tool_calls": tool_calls,
                    }
            elif not tool_calls and content and "<tool_call>" in content:
                # finish_reason=stop after tool use — the remaining text is
                # an intermediate observation, not a real answer.
                # Clear content to force a proper streaming final answer.
                logger.info(
                    "Round %d: Ignoring embedded tool call (finish_reason=stop, round>1), forcing final answer",
                    round_num,
                )
                content = ""

            logger.info(
                "Round %d: tool_calls=%s, content_len=%d",
                round_num,
                bool(tool_calls),
                len(content) if content else 0,
            )

            if not tool_calls or is_last_round:
                # Round 1: LLM skipped tools — prompt it to search
                if round_num == 1 and not is_last_round:
                    logger.info(
                        "Round 1: LLM skipped tools, prompting to search"
                    )
                    # Add LLM's response if it had content
                    if content:
                        conv_messages.append(
                            {"role": "assistant", "content": content}
                        )
                    # Ask LLM to use search tools
                    conv_messages.append({
                        "role": "user",
                        "content": (
                            "ユーザーの質問に答えるために、searchツールで検索してください。"
                            "適切な検索クエリを考えて検索を実行してください。"
                        ),
                    })
                    continue  # Go to next round

                # Answer looks negative and we haven't exhausted retries —
                # nudge the LLM to search with different keywords
                _negative_markers = ["見つかりませんでした", "記載されていません", "確認できません", "含まれていません"]
                if (
                    content
                    and not is_last_round
                    and round_num <= max_rounds - 2
                    and len(memory.searched_queries) < 3
                    and any(m in content for m in _negative_markers)
                ):
                    logger.info(
                        "Round %d: negative answer detected, prompting retry search",
                        round_num,
                    )
                    conv_messages.append(
                        {"role": "assistant", "content": content}
                    )
                    conv_messages.append({
                        "role": "user",
                        "content": (
                            "まだ見つかっていません。別のキーワードや言い換えで再度検索してください。"
                            "grepでの部分一致検索や、search_by_titleでのタイトル検索も試してください。"
                            "検索結果に含まれる全ての文書を read_document で確認してください。"
                        ),
                    })
                    continue

                # No tool calls (or last round) — generate final answer
                if content:
                    content = re.sub(
                        r"<tool_call>.*?</tool_call>", "", content, flags=re.DOTALL
                    ).strip()
                    content = _truncate_repetition(content)
                    if content:
                        for chunk in _chunk_text_for_streaming(content):
                            yield {"type": "token", "content": chunk}
                            await asyncio.sleep(0.02)
                        answer_generated = True
                        break

                # No content — force a streaming answer
                if round_num > 1:
                    conv_messages.append({
                        "role": "user",
                        "content": (
                            "これまでに収集した情報を元に、ユーザーの質問に回答してください。"
                            "ツールは使えません。直接回答してください。"
                        ),
                    })
                else:
                    conv_messages.append({
                        "role": "user",
                        "content": "ツールは使えません。直接回答してください。",
                    })
                async for evt in _stream_filtered(
                    conv_messages, cancel_event=cancel_event
                ):
                    yield evt
                answer_generated = True
                break

            # ---------------------------------------------------------------
            # Execute tool calls
            # ---------------------------------------------------------------
            conv_messages.append(message)

            for tc in tool_calls:

                func_info = tc.get("function", {})
                tool_name = func_info.get("name", "")
                try:
                    tool_args = json.loads(func_info.get("arguments", "{}"))
                except json.JSONDecodeError:
                    tool_args = {}

                tc_id = tc.get("id", f"call_{round_num}")

                yield {
                    "type": "tool_call",
                    "round": round_num,
                    "name": tool_name,
                    "arguments": tool_args,
                }

                result_text, sources = await execute_tool(
                    db, tool_name, tool_args, user=user
                )

                for s in sources:
                    if s["document_id"] not in seen_doc_ids:
                        seen_doc_ids.add(s["document_id"])
                        all_sources.append(s)

                tool_actions.append(
                    summarize_result_for_context(tool_name, tool_args, result_text)
                )

                # Update working memory
                if tool_name == "search":
                    memory.searched_queries.append(tool_args.get("query", ""))
                elif tool_name == "read_document":
                    doc_title = ""
                    for s in sources:
                        doc_title = s.get("title", "")
                        break
                    memory.read_documents.append({
                        "id": tool_args.get("id", ""),
                        "title": doc_title,
                        "summary": result_text[:150],
                    })

                yield {
                    "type": "tool_result",
                    "round": round_num,
                    "name": tool_name,
                    "summary": summarize_result(tool_name, result_text),
                }

                conv_messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result_text,
                })

        except CancelledByClient:
            raise
        except Exception:
            logger.exception("Agent loop error in round %d", round_num)
            break

    # -----------------------------------------------------------------------
    # Fallback: if no answer was generated, force one
    # -----------------------------------------------------------------------
    if not answer_generated and tool_actions:
        logger.info("Generating fallback answer (no answer from agent loop)")
        conv_messages.append({
            "role": "user",
            "content": (
                "これまでに収集した情報を元に、ユーザーの質問に回答してください。"
                "ツールは使えません。直接回答してください。"
            ),
        })
        try:
            async for evt in _stream_filtered(
                conv_messages, cancel_event=cancel_event
            ):
                yield evt
        except CancelledByClient:
            raise
        except Exception:
            logger.exception("Fallback answer generation failed")

    # -----------------------------------------------------------------------
    # Emit turn context and sources
    # -----------------------------------------------------------------------
    if tool_actions:
        turn_summary = "\n".join(tool_actions)
        # Cap at ~1500 chars to be context-window-friendly
        if len(turn_summary) > 1500:
            turn_summary = turn_summary[:1500] + "..."
        yield {"type": "turn_context", "summary": turn_summary}

    if all_sources:
        yield {"type": "sources", "sources": all_sources}

    yield {"type": "done"}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def _truncate_repetition(
    text: str, min_repeat_len: int = 20, max_repeats: int = 2
) -> str:
    """Detect and truncate repetitive text from LLM output."""
    for pattern_len in range(min_repeat_len, min(200, len(text) // 3), 5):
        for start in range(len(text) - pattern_len * (max_repeats + 1)):
            pattern = text[start : start + pattern_len]
            count = 0
            pos = start
            while pos + pattern_len <= len(text):
                if text[pos : pos + pattern_len] == pattern:
                    count += 1
                    pos += pattern_len
                else:
                    break
            if count > max_repeats:
                truncated = text[: start + pattern_len].rstrip("-_ ")
                return truncated
    return text


def _chunk_text_for_streaming(text: str, chunk_size: int = 8) -> list[str]:
    """Split text into small chunks to simulate streaming."""
    text = _truncate_repetition(text)
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
