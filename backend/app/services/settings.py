from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemSetting

# Default values (single source of truth)
DEFAULTS = {
    "llm_url": {
        "value": "http://host.docker.internal:8081/v1",
        "description": "LLM推論サーバーURL (OpenAI互換)",
        "placeholder": "http://localhost:8081/v1 or https://api.openai.com/v1",
    },
    "llm_model": {
        "value": "qwen3.5-35b-a3b",
        "description": "LLMモデル名",
        "placeholder": "gpt-4o, claude-3.5-sonnet, qwen3.5-35b-a3b",
    },
    "llm_api_key": {
        "value": "",
        "description": "LLM APIキー（外部API利用時。空欄ならキーなしで接続）",
        "placeholder": "sk-xxxx... (ローカルLLMなら空欄でOK)",
        "secret": True,
    },
    "embed_url": {
        "value": "http://host.docker.internal:8082/v1",
        "description": "Embeddingサーバー URL (OpenAI互換)",
        "placeholder": "http://localhost:8082/v1 or https://api.openai.com/v1",
    },
    "embed_model": {
        "value": "bge-m3",
        "description": "Embeddingモデル名",
        "placeholder": "bge-m3, text-embedding-3-small",
    },
    "embed_api_key": {
        "value": "",
        "description": "Embedding APIキー（外部API利用時。空欄ならキーなしで接続）",
        "placeholder": "sk-xxxx... (ローカルなら空欄でOK)",
        "secret": True,
    },
    "embed_dimensions": {
        "value": "1024",
        "description": "Embeddingベクトルの次元数",
        "placeholder": "1024 (bge-m3), 1536 (text-embedding-3-small)",
    },
    "chunk_size": {
        "value": "800",
        "description": "チャンク分割サイズ（文字数）",
        "placeholder": "800",
    },
    "chunk_overlap": {
        "value": "100",
        "description": "チャンクオーバーラップ（文字数）",
        "placeholder": "100",
    },
    "search_top_k": {
        "value": "20",
        "description": "検索結果の最大取得件数",
        "placeholder": "20",
    },
    "vector_similarity_threshold": {
        "value": "50",
        "description": "ベクトル検索の最低類似度 (%) — この値未満の結果を除外",
        "placeholder": "50",
    },
    "ai_max_search_rounds": {
        "value": "5",
        "description": "AI自律検索の最大ラウンド数",
        "placeholder": "3",
    },
    "share_server_url": {
        "value": "",
        "description": "Share Server の内部 API URL",
        "placeholder": "https://share.example.com",
    },
    "share_server_api_key": {
        "value": "",
        "description": "Share Server の API キー",
        "placeholder": "sk_xxxxx",
        "secret": True,
    },
    "share_enabled": {
        "value": "false",
        "description": "共有リンク機能の有効/無効 (true/false)",
        "placeholder": "true",
    },
    "default_share_prohibited": {
        "value": "false",
        "description": "新規アップロード時のデフォルト共有禁止 (true/false)",
        "placeholder": "false",
    },
    "default_download_prohibited": {
        "value": "false",
        "description": "新規アップロード時のデフォルトダウンロード禁止 (true/false)",
        "placeholder": "false",
    },
}


async def get_setting(db: AsyncSession, key: str) -> str:
    """Get a setting value, returning the default if not in DB."""
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key == key)
    )
    row = result.scalar_one_or_none()
    if row:
        return row.value
    default = DEFAULTS.get(key)
    return default["value"] if default else ""
