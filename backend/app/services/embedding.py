import httpx

from app.config import settings


async def get_embedding(text: str) -> list[float]:
    """Call the llama.cpp embedding server to get a single embedding vector."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{settings.EMBED_URL}/embedding",
            json={"content": text},
        )
        response.raise_for_status()
        data = response.json()
        return data["embedding"]


async def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Get embeddings for multiple texts. Sends them as individual requests
    concurrently for compatibility with llama.cpp server."""
    import asyncio

    async with httpx.AsyncClient(timeout=60.0) as client:

        async def _embed_one(text: str) -> list[float]:
            response = await client.post(
                f"{settings.EMBED_URL}/embedding",
                json={"content": text},
            )
            response.raise_for_status()
            data = response.json()
            return data["embedding"]

        results = await asyncio.gather(*[_embed_one(t) for t in texts])
        return list(results)
