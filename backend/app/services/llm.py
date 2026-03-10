import json
import logging
from typing import AsyncIterator

import httpx

from app.db import async_session
from app.services.settings import get_setting

logger = logging.getLogger(__name__)


async def _get_llm_config() -> tuple[str, str, str]:
    async with async_session() as db:
        url = await get_setting(db, "llm_url")
        model = await get_setting(db, "llm_model")
        api_key = await get_setting(db, "llm_api_key")
    return url, model, api_key


async def stream_chat(
    messages: list[dict[str, str]],
    context_chunks: list[str] | None = None,
) -> AsyncIterator[str]:
    """Stream chat completion from an OpenAI-compatible API.

    If context_chunks is provided, prepend a system message with RAG context.
    Yields text content tokens.
    """
    url, model, api_key = await _get_llm_config()

    if not url:
        yield "LLMサーバーが設定されていません。管理画面でLLM URLを設定してください。"
        return

    full_messages = []

    # System prompt with RAG context
    system_prompt = "あなたは社内文書検索AIアシスタントです。ユーザーの質問に対して、提供されたコンテキスト情報を元に正確で簡潔な回答を日本語で生成してください。コンテキストに含まれない情報は推測で答えず、その旨を伝えてください。"
    if context_chunks:
        context_text = "\n\n---\n\n".join(context_chunks)
        system_prompt += f"\n\n## 参照コンテキスト:\n{context_text}"

    full_messages.append({"role": "system", "content": system_prompt})
    full_messages.extend(messages)

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": full_messages,
        "stream": True,
        "temperature": 0.3,
        "max_tokens": 2048,
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            async with client.stream(
                "POST",
                f"{url}/chat/completions",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    logger.error(f"LLM API error {response.status_code}: {body.decode()}")
                    yield f"LLM APIエラー: {response.status_code}"
                    return

                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        parsed = json.loads(data)
                        delta = parsed.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content")
                        if content:
                            yield content
                    except (json.JSONDecodeError, IndexError, KeyError):
                        continue
    except httpx.ConnectError:
        yield "LLMサーバーに接続できません。サーバーが起動しているか確認してください。"
    except Exception as e:
        logger.exception("LLM streaming error")
        yield f"LLMエラー: {str(e)}"
