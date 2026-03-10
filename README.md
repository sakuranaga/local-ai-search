# LAS - Local AI Search

社内文書検索システム。PostgreSQL 全文検索 + ベクトル検索 + AI 自律回答を並列実行し、即座に検索結果を表示しつつ、AI が回答をストリーミング生成する。

## 主な機能

- **ハイブリッド検索**: pg_bigm 全文検索と pgvector ベクトル検索を並列実行し、RRF (Reciprocal Rank Fusion) でスコア統合
- **日本語形態素解析**: Janome による名詞抽出で自然文クエリを自動分解（「ホスラブサーバーへのログイン方法」→「ホスラブ」「サーバー」「ログイン」「方法」で OR 検索）
- **AI 自律検索エージェント**: ReAct 方式でツール（search, grep, title_search, read_document, count_results）を自律的に使い、情報を収集して回答を生成
- **SSE ストリーミング**: AI 回答をリアルタイムにトークン単位でストリーミング表示。ツール実行状況もリアルタイム表示
- **文書管理**: ファイルエクスプローラー形式の文書管理画面。フォルダ・タグ・一括操作・ゴミ箱対応
- **マルチフォーマット対応**: Markdown / PDF / DOCX / HTML のパース・チャンク分割・ベクトル化を自動実行
- **AI 要約**: 文書登録時に LLM で要約を自動生成。検索結果一覧に表示
- **管理画面**: ユーザー管理、ロール管理、システム設定（LLM/Embedding 接続先、検索パラメータ等）
- **認証**: JWT ベースの認証。ロール別アクセス制御（admin / editor / viewer）

## Tech Stack

| レイヤー | 技術 |
|----------|------|
| Frontend | React 19 + TypeScript 5.9, Vite 7, shadcn/ui, TailwindCSS 4 |
| Backend | Python 3.12, FastAPI, Gunicorn + Uvicorn (4 workers) |
| DB | PostgreSQL 18 + pgvector (ベクトル検索) + pg_bigm (高速 LIKE) |
| Cache | Redis 7 |
| LLM | llama.cpp (OpenAI 互換 API) - デフォルト: qwen3.5-35b-a3b |
| Embedding | llama.cpp (OpenAI 互換 API) - デフォルト: bge-m3 (1024 次元) |
| Proxy | Nginx (SPA + API リバースプロキシ + SSE 対応) |
| Container | Docker Compose |

## アーキテクチャ

```
┌──────────────┐     ┌─────────┐     ┌──────────────────────┐
│   Browser    │────▶│  Nginx  │────▶│  FastAPI Backend      │
│  (React SPA) │◀────│  :3002  │◀────│  (Gunicorn + Uvicorn) │
└──────────────┘     └─────────┘     └──────────┬───────────┘
                                                 │
                         ┌───────────────────────┼───────────────────────┐
                         ▼                       ▼                       ▼
                  ┌─────────────┐      ┌──────────────┐      ┌──────────────────┐
                  │ PostgreSQL  │      │    Redis     │      │   llama.cpp      │
                  │ pgvector    │      │              │      │ LLM :8081        │
                  │ pg_bigm     │      │              │      │ Embed :8082      │
                  └─────────────┘      └──────────────┘      └──────────────────┘
```

## セットアップ

### 前提条件

- Docker + Docker Compose
- llama.cpp サーバー 2 台（LLM 用 / Embedding 用）を起動済み
  - LLM: `llama-server -m <model.gguf> --port 8081 --host 0.0.0.0`
  - Embedding: `llama-server -m bge-m3-q8_0.gguf --port 8082 --host 0.0.0.0 --embedding`
- Node.js 20+ (フロントエンドビルド用)

### 1. リポジトリのクローンと設定

```bash
git clone <repository-url>
cd local-ai-search

# 環境変数を設定
cp .env.example .env
# .env を編集してパスワードとシークレットを変更
```

`.env` の内容:

```env
POSTGRES_PASSWORD=changeme
JWT_SECRET=changeme
LLM_URL=http://host.docker.internal:8081/v1
EMBED_URL=http://host.docker.internal:8082/v1
```

### 2. フロントエンドのビルド

```bash
cd frontend
npm install
npm run build
cd ..
```

### 3. Docker Compose で起動

```bash
docker compose up -d
```

起動されるサービス:

| サービス | 説明 | ポート |
|----------|------|--------|
| db | PostgreSQL 18 (pgvector + pg_bigm) | 内部のみ |
| redis | Redis 7 | 内部のみ |
| backend | FastAPI アプリケーション | 内部 8000 |
| nginx | リバースプロキシ + SPA 配信 | **3002** |

### 4. 初回ログイン

ブラウザで `http://localhost:3002` にアクセス。

初期管理者アカウント:
- ユーザー名: `admin`
- パスワード: `admin`

**初回ログイン後、必ずパスワードを変更してください。**

### 5. LLM / Embedding の設定

管理画面（右上のアバター → 管理）の「設定」タブで以下を確認・変更:

| 設定キー | デフォルト値 | 説明 |
|----------|-------------|------|
| `llm_url` | `http://host.docker.internal:8081/v1` | LLM 推論サーバー URL |
| `llm_model` | `qwen3.5-35b-a3b` | LLM モデル名 |
| `llm_api_key` | (空) | API キー（ローカル LLM なら空欄） |
| `embed_url` | `http://host.docker.internal:8082/v1` | Embedding サーバー URL |
| `embed_model` | `bge-m3` | Embedding モデル名 |
| `vector_similarity_threshold` | `70` | ベクトル検索の類似度閾値 (%) |
| `ai_max_search_rounds` | `3` | AI エージェントの最大検索ラウンド数 |

## プロジェクト構成

```
local-ai-search/
├── docker-compose.yml          # サービス定義
├── .env / .env.example         # 環境変数
├── nginx/
│   └── nginx.conf              # Nginx 設定 (SPA + API proxy + SSE)
├── db/
│   └── Dockerfile              # PostgreSQL + pgvector + pg_bigm
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py             # FastAPI アプリ + DB マイグレーション
│   │   ├── models.py           # SQLAlchemy モデル定義
│   │   ├── config.py           # 設定
│   │   ├── db.py               # DB セッション管理
│   │   ├── deps.py             # 依存注入 (認証等)
│   │   ├── routers/
│   │   │   ├── auth.py         # 認証 (login, refresh, me)
│   │   │   ├── users.py        # ユーザー CRUD
│   │   │   ├── roles.py        # ロール管理
│   │   │   ├── search.py       # 検索 API
│   │   │   ├── documents.py    # 文書 CRUD, アップロード, ダウンロード
│   │   │   ├── chat.py         # AI チャット (SSE) + LLM ステータス
│   │   │   ├── folders.py      # フォルダ管理
│   │   │   ├── tags.py         # タグ管理
│   │   │   └── settings.py     # システム設定
│   │   └── services/
│   │       ├── ai_agent.py     # ReAct エージェントループ
│   │       ├── llm.py          # LLM 呼び出し (chat, summary, streaming)
│   │       ├── search.py       # 全文検索 / ベクトル検索 / RRF マージ
│   │       ├── embedding.py    # Embedding 生成
│   │       ├── parser.py       # 文書パース + チャンク分割
│   │       ├── tokenizer.py    # 日本語形態素解析 (Janome)
│   │       └── settings.py     # 設定値の取得
│   └── scripts/
│       └── generate_summaries.py  # 一括要約生成スクリプト
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── App.tsx             # ルーティング + ナビバー
│   │   ├── lib/
│   │   │   └── api.ts          # API クライアント + 型定義
│   │   ├── pages/
│   │   │   ├── SearchPage.tsx  # 検索画面 (結果一覧 + AI チャット)
│   │   │   ├── AdminPage.tsx   # 管理画面
│   │   │   ├── FileExplorerPage.tsx  # 文書管理画面
│   │   │   └── LoginPage.tsx   # ログイン画面
│   │   └── components/
│   │       ├── ChatPanel.tsx   # AI チャットパネル
│   │       ├── ResultList.tsx  # 検索結果一覧
│   │       ├── DocumentModal.tsx  # 文書詳細モーダル
│   │       └── ui/             # shadcn/ui コンポーネント
│   └── dist/                   # ビルド成果物 (Nginx で配信)
├── data/                       # アップロードファイル保存先
└── docs/
    └── design.md               # 設計書
```

## 検索の仕組み

### 1. 全文検索 (pg_bigm)

日本語クエリを Janome で形態素解析し、名詞を抽出して OR 検索。マッチ数が多い順にランキング。pg_bigm の GIN インデックスで高速化。

### 2. ベクトル検索 (pgvector)

クエリ全文を Embedding モデルでベクトル化し、チャンクとのコサイン類似度で検索。設定可能な類似度閾値（デフォルト 70%）でフィルタ。

### 3. RRF マージ

全文検索とベクトル検索の結果を Reciprocal Rank Fusion (`score = 1/(k+rank)`, k=60) で統合。文書単位で重複排除し、スコア順に表示。

### 4. AI エージェント (ReAct)

LLM が以下のツールを自律的に使って情報を収集し、回答を生成:

| ツール | 説明 |
|--------|------|
| `search` | キーワード + 意味検索 (RRF マージ) |
| `grep` | 正確なテキストパターンの部分一致検索 |
| `search_by_title` | 文書タイトル・ファイル名で検索 |
| `read_document` | 文書 ID を指定して全文取得 |
| `count_results` | 検索クエリに一致する件数を確認 |

## 運用

### バックエンド再ビルド

```bash
docker compose up -d --build backend
```

### フロントエンド再ビルド

```bash
cd frontend && npm run build
# Nginx が dist/ を参照しているため、再起動不要
```

### ログ確認

```bash
docker compose logs backend --tail 50
docker compose logs -f backend  # リアルタイム
```

### 一括要約生成

要約未生成の文書に対して AI 要約を一括生成:

```bash
docker compose exec backend python scripts/generate_summaries.py
```

## API エンドポイント

| メソッド | パス | 説明 |
|----------|------|------|
| POST | `/api/auth/login` | ログイン |
| GET | `/api/auth/me` | 現在のユーザー情報 |
| GET | `/api/search?q=...` | ハイブリッド検索 |
| POST | `/api/chat/stream` | AI チャット (SSE) |
| GET | `/api/chat/status` | LLM 接続状態 + モデル名 |
| GET | `/api/documents` | 文書一覧 |
| POST | `/api/documents/upload` | 文書アップロード |
| GET | `/api/documents/{id}` | 文書詳細 |
| GET | `/api/documents/{id}/download` | 原本ダウンロード |
| PATCH | `/api/documents/{id}` | 文書更新 |
| DELETE | `/api/documents/{id}` | 文書削除 (ソフトデリート) |
| POST | `/api/documents/bulk-action` | 一括操作 |
| GET | `/api/folders` | フォルダ一覧 |
| GET | `/api/tags` | タグ一覧 |
| GET | `/api/users` | ユーザー一覧 (admin) |
| GET | `/api/roles` | ロール一覧 (admin) |
| GET | `/api/settings` | システム設定 (admin) |
| GET | `/api/stats` | 統計情報 |
| GET | `/api/health` | ヘルスチェック |

## 設計書

詳細な設計: [docs/design.md](docs/design.md)

## TODO

### 文書権限管理（ロールベースアクセス制御）

現在、文書の閲覧・編集権限はロール（admin / editor / viewer）による大まかな制御のみ実装済み。以下の機能が未実装:

- **文書単位の権限設定**: 個別文書に対するユーザー/ロール別の読み取り・書き込み権限の設定 UI
- **検索結果のフィルタリング**: ユーザーの権限に応じて、閲覧権限のない文書を検索結果から除外
- **AI エージェントの権限考慮**: AI が `read_document` 等で文書を参照する際の権限チェック
- **権限管理 UI**: 文書管理画面での権限設定ダイアログ（ユーザー選択、権限レベル設定）

DB モデル (`document_permissions` テーブル) とバックエンド API (`GET/PUT /api/documents/{id}/permissions`) は既に実装済み。フロントエンドの UI 統合と検索時の権限フィルタリングが残タスク。
