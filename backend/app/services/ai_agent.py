"""AI autonomous search agent using ReAct-style tool calling.

The agent iteratively calls tools (search, grep, read_document, search_by_title)
to find information, then generates a final answer with streaming.
"""

import asyncio
import json
import logging
import re
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User
from app.services.agent_tools import (
    SYSTEM_PROMPT,
    TOOLS,
    execute_tool,
    extract_tool_calls_from_text,
    summarize_result,
)
from app.services.llm import CancelledByClient, chat_completion, stream_chat_raw
from app.services.settings import get_setting

logger = logging.getLogger(__name__)


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
                    buffer = buffer[tag_end + len(_TAG_CLOSE):]
                else:
                    buffer = buffer[tag_start:]
                    break
    # Flush remaining buffer (strip any unclosed tool_call)
    if buffer:
        cleaned = re.sub(r"<tool_call>.*", "", buffer, flags=re.DOTALL).strip()
        if cleaned:
            yield {"type": "token", "content": cleaned}


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


async def run_agent(
    db: AsyncSession,
    messages: list[dict],
    existing_context: list[str] | None = None,
    user: User | None = None,
    cancel_event: asyncio.Event | None = None,
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
        if cancel_event and cancel_event.is_set():
            raise CancelledByClient()

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
        logger.info("Round %d: finish_reason=%s, has_content=%s, has_tool_calls=%s",
                     round_num, finish_reason, bool(message.get("content")),
                     bool(message.get("tool_calls")))

        # Check for tool calls (structured or embedded in text)
        tool_calls = message.get("tool_calls")
        content = message.get("content", "")

        # Some models embed tool calls in text instead of using tool_calls field
        if not tool_calls and content and "<tool_call>" in content:
            text_tool_calls, cleaned_content = extract_tool_calls_from_text(content)
            if text_tool_calls:
                logger.info("Round %d: Extracted %d tool calls from text", round_num, len(text_tool_calls))
                tool_calls = text_tool_calls
                content = cleaned_content
                message = {**message, "content": content, "tool_calls": tool_calls}

        logger.info("Round %d: tool_calls=%s, content_len=%d", round_num,
                     bool(tool_calls), len(content) if content else 0)

        if not tool_calls or is_last_round:
            # Round 1 without tools: LLM skipped search — force a search
            if round_num == 1 and not is_last_round:
                user_query = ""
                for m in reversed(messages):
                    if m.get("role") == "user":
                        user_query = m.get("content", "")
                        break
                if user_query:
                    logger.info("Round 1: LLM skipped tools, forcing search for: %s", user_query)
                    forced_tc = {
                        "id": "forced_search_1",
                        "type": "function",
                        "function": {"name": "search", "arguments": json.dumps({"query": user_query})},
                    }
                    yield {
                        "type": "tool_call",
                        "round": round_num,
                        "name": "search",
                        "arguments": {"query": user_query},
                    }
                    result_text, sources = await execute_tool(db, "search", {"query": user_query}, user=user)
                    for s in sources:
                        if s["document_id"] not in seen_doc_ids:
                            seen_doc_ids.add(s["document_id"])
                            all_sources.append(s)
                    yield {
                        "type": "tool_result",
                        "round": round_num,
                        "name": "search",
                        "summary": summarize_result("search", result_text),
                    }
                    if content:
                        conv_messages.append({"role": "assistant", "content": content, "tool_calls": [forced_tc]})
                    else:
                        conv_messages.append({"role": "assistant", "content": "", "tool_calls": [forced_tc]})
                    conv_messages.append({
                        "role": "tool",
                        "tool_call_id": "forced_search_1",
                        "content": result_text,
                    })
                    continue  # Go to next round

            # No tool calls (or last round) — generate final answer
            if not content and round_num > 1:
                logger.warning("LLM returned empty content after tool rounds, forcing final answer")
                conv_messages.append({
                    "role": "user",
                    "content": "これまでに収集した情報を元に、ユーザーの質問に回答してください。ツールは使えません。直接回答してください。",
                })
                async for evt in _stream_filtered(conv_messages, cancel_event=cancel_event):
                    yield evt
            elif content:
                content = re.sub(r"<tool_call>.*?</tool_call>", "", content, flags=re.DOTALL).strip()
                content = _truncate_repetition(content)
                if content:
                    for chunk in _chunk_text_for_streaming(content):
                        yield {"type": "token", "content": chunk}
                        await asyncio.sleep(0.02)
                else:
                    conv_messages.append({
                        "role": "user",
                        "content": "ツールは使えません。直接回答してください。",
                    })
                    async for evt in _stream_filtered(conv_messages, cancel_event=cancel_event):
                        yield evt
            else:
                conv_messages.append({
                    "role": "user",
                    "content": "ツールは使えません。直接回答してください。",
                })
                async for evt in _stream_filtered(conv_messages, cancel_event=cancel_event):
                    yield evt
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

            yield {
                "type": "tool_call",
                "round": round_num,
                "name": tool_name,
                "arguments": tool_args,
            }

            result_text, sources = await execute_tool(db, tool_name, tool_args, user=user)

            for s in sources:
                if s["document_id"] not in seen_doc_ids:
                    seen_doc_ids.add(s["document_id"])
                    all_sources.append(s)

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

    # Send sources
    if all_sources:
        yield {"type": "sources", "sources": all_sources}

    yield {"type": "done"}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def _truncate_repetition(text: str, min_repeat_len: int = 20, max_repeats: int = 2) -> str:
    """Detect and truncate repetitive text from LLM output."""
    for pattern_len in range(min_repeat_len, min(200, len(text) // 3), 5):
        for start in range(len(text) - pattern_len * (max_repeats + 1)):
            pattern = text[start:start + pattern_len]
            count = 0
            pos = start
            while pos + pattern_len <= len(text):
                if text[pos:pos + pattern_len] == pattern:
                    count += 1
                    pos += pattern_len
                else:
                    break
            if count > max_repeats:
                truncated = text[:start + pattern_len].rstrip("-_ ")
                return truncated
    return text


def _chunk_text_for_streaming(text: str, chunk_size: int = 8) -> list[str]:
    """Split text into small chunks to simulate streaming."""
    text = _truncate_repetition(text)
    return [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
