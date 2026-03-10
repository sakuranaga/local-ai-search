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


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    use_search: bool = True


@router.post("/stream")
async def chat_stream(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint for chat with optional RAG context.

    If use_search is True, the latest user message is used to search
    for relevant document chunks that are injected as context.
    """
    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    # Get the latest user message for search
    context_chunks: list[str] | None = None
    sources: list[dict] = []

    if body.use_search and messages:
        last_user_msg = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"),
            None,
        )
        if last_user_msg:
            results, _ = await merged_search(db, last_user_msg, limit=5, offset=0)
            if results:
                context_chunks = [r["content"] for r in results]
                sources = [
                    {
                        "document_id": r["document_id"],
                        "title": r["document_title"],
                        "chunk_id": r["chunk_id"],
                    }
                    for r in results
                ]

    async def event_generator():
        # Send sources first
        if sources:
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"

        # Stream LLM response
        async for token in stream_chat(messages, context_chunks):
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
