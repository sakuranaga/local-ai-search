import asyncio

import httpx

from app.config import settings
from app.db import async_session
from app.services.settings import get_setting


async def _get_embed_config() -> tuple[str, str, str]:
    """Get embed URL, model, and API key from DB settings."""
    async with async_session() as db:
        url = await get_setting(db, "embed_url")
        model = await get_setting(db, "embed_model")
        api_key = await get_setting(db, "embed_api_key")
    return url or settings.EMBED_URL, model or "bge-m3", api_key or ""


def _build_headers(api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def get_embedding(text: str) -> list[float]:
    """Get a single embedding vector from the embedding server."""
    url, model, api_key = await _get_embed_config()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{url}/embeddings",
            headers=_build_headers(api_key),
            json={"input": text, "model": model},
        )
        response.raise_for_status()
        data = response.json()
        return data["data"][0]["embedding"]


async def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Get embeddings for multiple texts concurrently."""
    url, model, api_key = await _get_embed_config()
    headers = _build_headers(api_key)

    async with httpx.AsyncClient(timeout=120.0) as client:

        async def _embed_one(text: str) -> list[float]:
            response = await client.post(
                f"{url}/embeddings",
                headers=headers,
                json={"input": text, "model": model},
            )
            response.raise_for_status()
            data = response.json()
            return data["data"][0]["embedding"]

        results: list[list[float]] = []
        batch_size = 10
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            batch_results = await asyncio.gather(*[_embed_one(t) for t in batch])
            results.extend(batch_results)

        return results
