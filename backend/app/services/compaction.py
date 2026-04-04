"""Conversation compaction for the AI agent.

Compresses old messages into a structured summary to prevent
context window overflow while preserving essential information.

Rule-based (no LLM calls) — extracts user requests, tool usage,
referenced documents, and answer summaries from message patterns.
"""

import re

PRESERVE_RECENT_PAIRS = 2  # Keep last 2 user+assistant pairs
MAX_ESTIMATED_TOKENS = 8000  # Trigger compaction above this
CHAR_PER_TOKEN = 2  # Japanese: ~2 chars per token


def estimate_tokens(messages: list[dict]) -> int:
    """Estimate token count for a list of messages."""
    total_chars = sum(len(m.get("content", "")) for m in messages)
    return total_chars // CHAR_PER_TOKEN


def should_compact(messages: list[dict]) -> bool:
    """Check if compaction is needed (excludes system messages)."""
    non_system = [m for m in messages if m.get("role") != "system"]
    if len(non_system) <= PRESERVE_RECENT_PAIRS * 2:
        return False
    # Only count compactable (old) messages
    compactable = non_system[: -(PRESERVE_RECENT_PAIRS * 2)]
    return estimate_tokens(compactable) > MAX_ESTIMATED_TOKENS


def compact_messages(messages: list[dict]) -> list[dict]:
    """Replace old messages with a structured summary.

    Returns a new message list: [system, compact_summary_system, recent_messages...]
    """
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    preserve_count = PRESERVE_RECENT_PAIRS * 2
    to_compact = non_system[:-preserve_count]
    to_preserve = non_system[-preserve_count:]

    # Check if the first compactable message is already a compaction summary
    existing_summary = None
    if to_compact and to_compact[0].get("_compact_summary"):
        existing_summary = to_compact[0].get("content", "")
        to_compact = to_compact[1:]

    summary = _build_summary(to_compact, existing_summary)

    result = system_msgs.copy()
    result.append({
        "role": "system",
        "content": summary,
        "_compact_summary": True,  # Marker for re-compaction
    })
    result.extend(to_preserve)
    return result


def _build_summary(messages: list[dict], existing_summary: str | None) -> str:
    """Generate a structured summary from messages."""
    user_requests: list[str] = []
    tools_used: dict[str, int] = {}
    documents_read: list[str] = []
    key_findings: list[str] = []

    for m in messages:
        content = m.get("content", "")
        role = m.get("role", "")

        if role == "user":
            # Strip timestamp prefix like "[2026-04-04T...] "
            cleaned = re.sub(r"^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*", "", content)
            user_requests.append(cleaned[:160])

        elif role == "assistant":
            # Extract tool usage from turn_context format
            if "[前回のツール使用結果]" in content:
                tc_part = content.split("[前回のツール使用結果]")[1]
                if "[回答]" in tc_part:
                    tc_part = tc_part.split("[回答]")[0]
                for line in tc_part.strip().split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    # Pattern: "search(query=...): ..." or "read_document(id=...): ..."
                    match = re.match(r"^(\w+)\(", line)
                    if match:
                        tool_name = match.group(1)
                        tools_used[tool_name] = tools_used.get(tool_name, 0) + 1
                    # Extract document references from read_document lines
                    doc_match = re.search(r"read_document\(.*?\):\s*(.*)", line)
                    if doc_match:
                        doc_info = doc_match.group(1)[:80]
                        documents_read.append(doc_info)

            # Extract answer summary
            answer_part = content
            if "[回答]" in content:
                answer_part = content.split("[回答]")[-1]
            answer_part = answer_part.strip()
            if answer_part:
                key_findings.append(answer_part[:200])

    # Build summary
    lines = ["<compact_summary>", "## 会話サマリー（圧縮済み）"]

    if existing_summary:
        lines.append(f"\n### 以前の圧縮コンテキスト\n{existing_summary}")
        lines.append("\n### 新たに圧縮された内容")

    user_count = sum(1 for m in messages if m.get("role") == "user")
    asst_count = sum(1 for m in messages if m.get("role") == "assistant")
    lines.append(f"メッセージ数: ユーザー{user_count}件、アシスタント{asst_count}件\n")

    if user_requests:
        lines.append("### ユーザーのリクエスト")
        for i, req in enumerate(user_requests[-5:], 1):
            lines.append(f"{i}. {req}")

    if documents_read:
        lines.append("\n### 参照した文書")
        for doc in documents_read[-10:]:
            lines.append(f"- {doc}")

    if tools_used:
        lines.append("\n### 使用したツール")
        for tool, count in tools_used.items():
            lines.append(f"- {tool}: {count}回")

    if key_findings:
        lines.append("\n### 直前の回答要旨")
        lines.append(key_findings[-1])

    lines.append("</compact_summary>")
    return "\n".join(lines)
