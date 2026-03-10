import asyncio
import json

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.services.search import fulltext_search, merged_search, vector_search

router = APIRouter(prefix="/search", tags=["search"])


@router.get("/")
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    mode: str = Query("merged", regex="^(fulltext|vector|merged)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search documents using fulltext, vector, or merged (RRF) strategies."""
    if mode == "fulltext":
        results = await fulltext_search(db, q, limit=limit)
    elif mode == "vector":
        results = await vector_search(db, q, limit=limit)
    else:
        results = await merged_search(db, q, limit=limit)

    return {"query": q, "mode": mode, "count": len(results), "results": results}


@router.get("/stream")
async def search_stream(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE endpoint that streams an AI-generated answer based on search results.

    This is a placeholder that returns search context chunks via SSE.
    The actual LLM streaming will be wired up when the llama.cpp completion
    endpoint is integrated.
    """
    # First, get search results for context
    results = await merged_search(db, q, limit=limit)

    async def event_generator():
        # Send context chunks
        context_parts = []
        for r in results:
            context_parts.append(r["content"])
            event_data = json.dumps(
                {
                    "type": "context",
                    "document_title": r["document_title"],
                    "chunk_id": r["chunk_id"],
                }
            )
            yield f"data: {event_data}\n\n"

        # Placeholder: stream a simple response indicating LLM integration pending
        # In production, this would call the LLM_URL /completion endpoint with
        # the search context and stream back tokens.
        yield f"data: {json.dumps({'type': 'answer_start'})}\n\n"

        placeholder_answer = (
            f"Found {len(results)} relevant chunks for query: '{q}'. "
            "LLM streaming will be connected to the llama.cpp server."
        )
        # Simulate token streaming
        for word in placeholder_answer.split():
            yield f"data: {json.dumps({'type': 'token', 'content': word + ' '})}\n\n"
            await asyncio.sleep(0.02)

        yield f"data: {json.dumps({'type': 'answer_end'})}\n\n"
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
