import json

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.services.ai_agent import run_agent
from app.services.settings import get_setting

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


@router.get("/status")
async def chat_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check LLM connectivity and return model name."""
    model = await get_setting(db, "llm_model")
    url = await get_setting(db, "llm_url")
    api_key = await get_setting(db, "llm_api_key")

    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"{url}/models", headers=headers)
            available = res.status_code == 200
    except Exception:
        available = False

    return {"model": model, "available": available}


@router.post("/stream")
async def chat_stream(
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint for AI chat with autonomous search (ReAct agent).

    The AI agent autonomously decides which tools to use (search, grep,
    read_document, search_by_title) to find information and answer the user.
    """
    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    # Carried-over context from frontend
    existing_context = [c.content for c in body.context] if body.context else None

    async def event_generator():
        async for event in run_agent(db, messages, existing_context):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
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
