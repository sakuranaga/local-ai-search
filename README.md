# LAS - Local AI Search

社内文書検索システム。PostgreSQL全文検索 + ベクトル検索 + AI自律回答を並列実行し、即座に検索結果を表示しつつ、AIが回答をストリーミング生成する。

## Tech Stack

- **Frontend**: React + TypeScript, shadcn/ui, TailwindCSS
- **Backend**: Python FastAPI (Gunicorn + Uvicorn)
- **DB**: PostgreSQL 18 + pgvector + pg_bigm
- **PubSub**: Redis
- **LLM**: llama.cpp (qwen3.5-35b-a3b)
- **Embedding**: llama.cpp (bge-m3)
- **Web Server**: Nginx

## Docs

設計書: [docs/design.md](docs/design.md)
