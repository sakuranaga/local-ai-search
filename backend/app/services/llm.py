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


def _build_headers(api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def chat_completion(
    messages: list[dict],
    tools: list[dict] | None = None,
) -> dict:
    """Non-streaming chat completion with optional tool support.

    Returns the full response dict from the API.
    """
    url, model, api_key = await _get_llm_config()

    if not url:
        return {
            "choices": [{"message": {"role": "assistant", "content": "LLMサーバーが設定されていません。"}, "finish_reason": "stop"}]
        }

    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": False,
        "temperature": 0.3,
        "max_tokens": 2048,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            response = await client.post(
                f"{url}/chat/completions",
                json=payload,
                headers=_build_headers(api_key),
            )
            if response.status_code != 200:
                logger.error(f"LLM API error {response.status_code}: {response.text}")
                return {
                    "choices": [{"message": {"role": "assistant", "content": f"LLM APIエラー: {response.status_code}"}, "finish_reason": "stop"}]
                }
            return response.json()
    except httpx.ConnectError:
        return {
            "choices": [{"message": {"role": "assistant", "content": "LLMサーバーに接続できません。"}, "finish_reason": "stop"}]
        }
    except Exception as e:
        logger.exception("LLM completion error")
        return {
            "choices": [{"message": {"role": "assistant", "content": f"LLMエラー: {e}"}, "finish_reason": "stop"}]
        }


async def stream_chat_raw(
    messages: list[dict],
) -> AsyncIterator[str]:
    """Stream chat completion without injecting system prompt.

    Used by the agent for the final answer streaming.
    """
    url, model, api_key = await _get_llm_config()

    if not url:
        yield "LLMサーバーが設定されていません。管理画面でLLM URLを設定してください。"
        return

    payload = {
        "model": model,
        "messages": messages,
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
                headers=_build_headers(api_key),
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


# Legacy function kept for backward compatibility
async def stream_chat(
    messages: list[dict[str, str]],
    context_chunks: list[str] | None = None,
) -> AsyncIterator[str]:
    """Stream chat completion with RAG context injection."""
    system_prompt = "あなたは社内文書検索AIアシスタントです。ユーザーの質問に対して、提供されたコンテキスト情報を元に正確で簡潔な回答を日本語で生成してください。コンテキストに含まれない情報は推測で答えず、その旨を伝えてください。"
    if context_chunks:
        context_text = "\n\n---\n\n".join(context_chunks)
        system_prompt += f"\n\n## 参照コンテキスト:\n{context_text}"

    full_messages = [{"role": "system", "content": system_prompt}] + messages
    async for token in stream_chat_raw(full_messages):
        yield token
