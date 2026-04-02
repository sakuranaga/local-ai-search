import asyncio
import json
import logging

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_db
from app.deps import get_current_user
from app.models import ChatConversation, ChatMessage as ChatMessageModel, User
from app.services.ai_agent import run_agent
from app.services.llm import CancelledByClient
from app.services.settings import get_setting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    turn_context: str | None = None  # Tool action summary from previous turn


class ContextChunk(BaseModel):
    content: str
    document_id: str
    title: str
    chunk_id: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: list[ContextChunk] = []  # Carried-over RAG context from previous turns


class SaveMessageRequest(BaseModel):
    query: str
    role: str
    content: str
    turn_context: str | None = None
    sources: list | None = None
    tool_steps: list | None = None


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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint for AI chat with autonomous search (ReAct agent).

    The AI agent autonomously decides which tools to use (search, grep,
    read_document, search_by_title) to find information and answer the user.
    Creates a per-request cancel event so disconnecting clients don't waste
    LLM inference resources.
    """
    messages = [
        {"role": m.role, "content": m.content, **({"turn_context": m.turn_context} if m.turn_context else {})}
        for m in body.messages
    ]

    # Carried-over context from frontend
    existing_context = [c.content for c in body.context] if body.context else None

    # Per-request cancellation: set when the client disconnects
    cancel_event = asyncio.Event()

    async def _monitor_disconnect():
        """Poll Request.is_disconnected() and signal cancellation."""
        while not cancel_event.is_set():
            if await request.is_disconnected():
                logger.info("Client disconnected, cancelling LLM inference")
                cancel_event.set()
                return
            await asyncio.sleep(0.5)

    async def event_generator():
        monitor_task = asyncio.create_task(_monitor_disconnect())
        try:
            async for event in run_agent(
                db, messages, existing_context,
                user=current_user, cancel_event=cancel_event,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except CancelledByClient:
            logger.info("Agent cancelled by client disconnect")
        finally:
            cancel_event.set()  # stop the monitor
            monitor_task.cancel()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/conversations")
async def get_conversation(
    query: str = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get conversation by search query for the current user."""
    result = await db.execute(
        select(ChatConversation)
        .options(selectinload(ChatConversation.messages))
        .where(
            ChatConversation.user_id == current_user.id,
            ChatConversation.query == query,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        return None

    return {
        "id": str(conv.id),
        "query": conv.query,
        "messages": [
            {
                "id": str(m.id),
                "role": m.role,
                "content": m.content,
                "turn_context": m.turn_context,
                "sources": m.sources,
                "tool_steps": m.tool_steps,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in conv.messages
        ],
        "created_at": conv.created_at.isoformat() if conv.created_at else None,
        "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
    }


@router.post("/messages")
async def save_message(
    body: SaveMessageRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save a chat message. Creates conversation if it doesn't exist."""
    # Upsert conversation
    result = await db.execute(
        select(ChatConversation).where(
            ChatConversation.user_id == current_user.id,
            ChatConversation.query == body.query,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        conv = ChatConversation(user_id=current_user.id, query=body.query)
        db.add(conv)
        await db.flush()

    msg = ChatMessageModel(
        conversation_id=conv.id,
        role=body.role,
        content=body.content,
        turn_context=body.turn_context,
        sources=body.sources,
        tool_steps=body.tool_steps,
    )
    db.add(msg)
    await db.commit()

    return {"id": str(msg.id), "conversation_id": str(conv.id)}


@router.delete("/conversations")
async def delete_conversation(
    query: str = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete conversation by search query (cascade deletes messages)."""
    result = await db.execute(
        select(ChatConversation).where(
            ChatConversation.user_id == current_user.id,
            ChatConversation.query == query,
        )
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        return {"deleted": False}

    await db.delete(conv)
    await db.commit()
    return {"deleted": True}
