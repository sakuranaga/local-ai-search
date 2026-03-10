import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.services.llm import stream_chat
from app.services.search import merged_search

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ContextChunk(BaseModel):
    content: str
    document_id: str
    title: str
    chunk_id: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: list[ContextChunk] = []  # Carried-over RAG context from previous turns


@router.post("/stream")
async def chat_stream(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint for chat with RAG context.

    On the first message, searches for context. On follow-ups, reuses
    the carried-over context and optionally supplements with new search
    results if the question seems to be a new topic.
    """
    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    # Carried-over context from frontend
    existing_context = [c.content for c in body.context]
    existing_sources = [
        {"document_id": c.document_id, "title": c.title, "chunk_id": c.chunk_id}
        for c in body.context
    ]

    new_sources: list[dict] = []
    new_context: list[str] = []

    # Search for additional context based on latest user message
    last_user_msg = next(
        (m["content"] for m in reversed(messages) if m["role"] == "user"),
        None,
    )

    is_first_message = len(messages) == 1
    if last_user_msg:
        # First message: always search. Follow-ups: search if message
        # looks like a new question (> 5 chars and not a simple follow-up)
        should_search = is_first_message or (
            len(last_user_msg) > 5
            and not any(
                last_user_msg.strip().startswith(p)
                for p in ("もっと", "詳しく", "具体的", "例えば", "なぜ", "はい", "いいえ",
                          "続き", "要約", "まとめ", "ありがとう", "OK", "ok", "わかり")
            )
        )

        if should_search:
            results, _ = await merged_search(db, last_user_msg, limit=5, offset=0, require_ai_knowledge=True)
            # Deduplicate against existing context
            existing_chunk_ids = {c.chunk_id for c in body.context}
            for r in results:
                if r["chunk_id"] not in existing_chunk_ids:
                    new_context.append(r["content"])
                    new_sources.append({
                        "document_id": r["document_id"],
                        "title": r["document_title"],
                        "chunk_id": r["chunk_id"],
                    })

    # Merge all context
    all_context = existing_context + new_context
    all_sources = existing_sources + new_sources

    # Build full context entries with content for frontend caching
    all_context_entries = [
        {"content": c, "document_id": s["document_id"], "title": s["title"], "chunk_id": s["chunk_id"]}
        for c, s in zip(all_context, all_sources)
    ] if len(all_context) == len(all_sources) else []

    async def event_generator():
        # Send context (sources + content) so frontend can carry it forward
        if all_context_entries:
            yield f"data: {json.dumps({'type': 'context', 'context': all_context_entries})}\n\n"
        elif all_sources:
            yield f"data: {json.dumps({'type': 'sources', 'sources': all_sources})}\n\n"

        # Stream LLM response
        async for token in stream_chat(messages, all_context if all_context else None):
            yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
