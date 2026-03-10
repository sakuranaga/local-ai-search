# LAS (Local AI Search) 設計書

## 1. 概要

社内文書検索システム。PostgreSQL全文検索＋ベクトル検索＋AI自律回答を並列実行し、
即座に検索結果を表示しつつ、AIが回答をストリーミング生成する。

**コンセプト**: AIが入った超検索システム（チャットUI ではない）

## 2. システム構成

```
┌─────────────────────────────────────────────────┐
│                  Web Frontend (React)            │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ 検索バー  │  │  AI回答パネル │  │ファイル    │  │
│  │ +結果一覧 │  │ (streaming)  │  │ブラウザ    │  │
│  └──────────┘  └──────────────┘  └───────────┘  │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
┌──────────────────▼──────────────────────────────┐
│              Nginx (リバースプロキシ/静的配信)     │
└──────────────────┬──────────────────────────────┘
                   │ Unix Socket
┌──────────────────▼──────────────────────────────┐
│         Gunicorn + Uvicorn workers               │
│              FastAPI Backend                      │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌───────┐  │
│  │Search  │  │AI Agent│  │Ingest  │  │Files  │  │
│  │API     │  │API     │  │API     │  │API    │  │
│  │        │  │        │  │        │  │       │  │
│  │ Auth   │  │Users   │  │Roles   │  │Perms  │  │
│  └───┬────┘  └───┬────┘  └───┬────┘  └───┬───┘  │
└──────┼───────────┼───────────┼────────────┼──────┘
       │           │           │            │
┌──────▼───────────┼───────────▼────────────┼──────┐
│  PostgreSQL 18   │                        │      │
│  + pgvector      │     ┌──────────────┐   │      │
│  + pg_bigm       │     │ llama.cpp    │   │      │
│                  ├────>│ :8081 (Chat) │   │      │
│  documents       │     │ :8082 (Embed)│   │      │
│  chunks    ┌─────┤     └──────────────┘   │      │
│  files     │Redis│                     storage/  │
│  users     │PubSub│                              │
│  roles     └─────┘                      ┌────────▼┐
└──────────────────┘                      │ data/   │
                                          │ files/  │
                                          └─────────┘
```

## 3. 技術スタック

| レイヤー | 技術 | 備考 |
|---------|------|------|
| Frontend | React + TypeScript | Vite, TailwindCSS, shadcn/ui |
| Web Server | Nginx | リバースプロキシ, 静的配信, SSL終端 |
| WSGI/ASGI | Gunicorn + Uvicorn workers | 本番運用, Unix Socket接続 |
| Backend | Python FastAPI | async |
| DB | PostgreSQL 18 + pgvector + pg_bigm | Docker |
| PubSub/Cache | Redis | SSEブロードキャスト, セッション, ジョブキュー |
| LLM | llama.cpp (Vulkan) | qwen3.5-35b-a3b, port 8081 |
| Embedding | llama.cpp (Vulkan) | bge-m3, port 8082 |
| ファイル解析 | python-docx, PyMuPDF, markdown | MD/PDF/DOCX対応 |

## 4. データモデル

### documents テーブル
```sql
CREATE TABLE documents (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    source_path TEXT,              -- 元ファイルパス
    file_type   TEXT NOT NULL,     -- md, pdf, docx
    content     TEXT NOT NULL,     -- 全文（プレーンテキスト）
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- pg_bigm 全文検索インデックス
CREATE INDEX idx_documents_content_bigm ON documents
    USING gin (content gin_bigm_ops);
CREATE INDEX idx_documents_title_bigm ON documents
    USING gin (title gin_bigm_ops);
```

### chunks テーブル
```sql
CREATE TABLE chunks (
    id          SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1024),     -- bge-m3 = 1024次元
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chunks_embedding ON chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### files テーブル
```sql
CREATE TABLE files (
    id          SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    filename    TEXT NOT NULL,
    filepath    TEXT NOT NULL,     -- storage上のパス
    file_size   BIGINT,
    mime_type   TEXT,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TIMESTAMPTZ DEFAULT now()
);
```

### users テーブル
```sql
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    is_active     BOOLEAN DEFAULT TRUE,
    is_superadmin BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### roles テーブル
```sql
CREATE TABLE roles (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,   -- 例: admin, editor, viewer
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- デフォルトロール
-- admin:  全操作可能
-- editor: 文書の閲覧・アップロード・編集・削除
-- viewer: 文書の閲覧・検索のみ
```

### user_roles テーブル
```sql
CREATE TABLE user_roles (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);
```

### document_permissions テーブル
```sql
-- 文書単位のアクセス制御（オプション）
-- NULLの場合は全ユーザーにロールベースのデフォルト権限を適用
CREATE TABLE document_permissions (
    id          SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role_id     INTEGER REFERENCES roles(id) ON DELETE CASCADE,
    permission  TEXT NOT NULL,  -- read, write, delete
    CONSTRAINT chk_target CHECK (
        (user_id IS NOT NULL AND role_id IS NULL) OR
        (user_id IS NULL AND role_id IS NOT NULL)
    )
);
```

## 5. 認証・認可

### 5.1 認証
- JWT (JSON Web Token) ベース
- アクセストークン (短寿命: 30分) + リフレッシュトークン (長寿命: 7日)
- Redis でセッション管理・トークン無効化

### 5.2 権限モデル
```
superadmin
  └─ ユーザー管理、ロール管理、システム設定、全文書操作

admin (ロール)
  └─ 文書管理（アップロード/削除/編集）、取り込み実行、ファイルブラウザ全操作

editor (ロール)
  └─ 文書アップロード/編集、検索、AI回答、ファイル閲覧

viewer (ロール)
  └─ 検索、AI回答、文書閲覧のみ
```

### 5.3 文書レベル権限（細かい制御）
- デフォルト: ロールベースで全文書にアクセス可能
- オプション: 文書ごとにユーザー/ロール単位でアクセス制限を設定可能
- 検索時に権限フィルタを適用（権限のない文書は検索結果に出ない）

### 5.4 API認可
全APIエンドポイントに権限チェックミドルウェアを適用：
```python
@router.post("/documents/upload")
async def upload(file: UploadFile, user: User = Depends(require_permission("document:write"))):
    ...
```

## 6. 検索フロー

ユーザーがクエリを入力すると、3つの処理が**並列**で走る：

### 5.1 全文検索 (即時表示)
```
クエリ → pg_bigm LIKE検索 → スコア付き結果 → フロントエンドに即時返却
```
- 日本語2-gram対応（pg_bigm）
- 応答時間: ~10ms
- タイトル一致はブースト

### 5.2 ベクトル検索 (即時表示)
```
クエリ → bge-m3 embedding → pgvector cosine similarity → 結果マージ
```
- 意味的類似度による検索
- 応答時間: ~100ms（embedding生成含む）

### 5.3 AI回答生成 (ストリーミング)
```
クエリ → 検索結果Top-K取得 → プロンプト構築 → LLM streaming → フロントエンドに逐次表示
```
- 全文検索＋ベクトル検索の上位結果をコンテキストに使用
- 必要に応じて追加検索を自律的に実行（ReAct的アプローチ）
- Server-Sent Events (SSE) でストリーミング

### 検索結果マージ
全文検索とベクトル検索の結果を Reciprocal Rank Fusion (RRF) でマージ：
```
RRF_score(d) = Σ 1/(k + rank_i(d))   (k=60)
```

## 7. AI自律検索 (ReAct)

単発RAGでは不十分な場合、AIが自律的に追加検索を実行する。

```
System: あなたは社内文書検索アシスタントです。
ユーザーの質問に答えるため、searchツールを使って情報を探してください。

Tools:
  - search(query): 社内文書を検索
  - read_document(id): 文書の全文を取得

1回目: ユーザーのクエリで検索
2回目: 不足情報があれば別のクエリで追加検索
3回目: 必要なら文書全文を読む
最終: 収集した情報を元に回答を生成
```

最大3回の検索ループ。ツールコール形式でLLMに判断させる。

## 8. API設計

### 認証
```
POST /api/auth/login            -- ログイン → JWT発行
POST /api/auth/refresh          -- トークン更新
POST /api/auth/logout           -- ログアウト（トークン無効化）
GET  /api/auth/me               -- 現在のユーザー情報
```

### ユーザー管理 (admin/superadmin)
```
GET    /api/users               -- ユーザー一覧
POST   /api/users               -- ユーザー作成
PUT    /api/users/{id}          -- ユーザー更新
DELETE /api/users/{id}          -- ユーザー削除
PUT    /api/users/{id}/roles    -- ロール割り当て
```

### ロール管理 (superadmin)
```
GET    /api/roles               -- ロール一覧
POST   /api/roles               -- ロール作成
PUT    /api/roles/{id}          -- ロール更新（権限変更）
DELETE /api/roles/{id}          -- ロール削除
```

### 文書権限 (admin)
```
GET    /api/documents/{id}/permissions   -- 文書の権限一覧
PUT    /api/documents/{id}/permissions   -- 文書の権限設定
```

### 検索
```
GET /api/search?q={query}&limit=20
→ { fulltext_results: [...], vector_results: [...], merged: [...] }

GET /api/search/stream?q={query}
→ SSE: AI回答をストリーミング
```

### ドキュメント管理
```
POST   /api/documents/upload     -- ファイルアップロード＋パース＋チャンク＋embedding
GET    /api/documents            -- 一覧
GET    /api/documents/{id}       -- 詳細＋全文
DELETE /api/documents/{id}       -- 削除
```

### ファイルブラウザ
```
GET /api/files?path={dir}        -- ディレクトリ一覧
GET /api/files/{id}/download     -- ダウンロード
GET /api/files/{id}/preview      -- プレビュー（MD/PDF）
```

### 一括取り込み
```
POST /api/ingest/directory       -- ディレクトリ一括取り込み
POST /api/ingest/wiki-sync      -- wiki_sync連携（既存MD取り込み）
GET  /api/ingest/status          -- 取り込み状況
```

## 9. フロントエンド構成

```
/                    -- 検索メイン画面
/files               -- ファイルブラウザ
/documents/{id}      -- 文書詳細表示
/admin               -- 管理（取り込み、設定）
```

### 検索メイン画面レイアウト
```
┌─────────────────────────────────────────────┐
│  [🔍 検索クエリ入力                    [検索]] │
├──────────────────────┬──────────────────────┤
│                      │                      │
│  検索結果一覧         │  AI回答              │
│  (即時表示)           │  (ストリーミング)     │
│                      │                      │
│  📄 VPS/割引 (0.95)  │  VPSのログイン情報は  │
│  📄 VPS/設定 (0.87)  │  以下の通りです：     │
│  📄 サーバー管理(0.82)│  ...                 │
│  ...                 │  [出典: VPS/割引]     │
│                      │                      │
├──────────────────────┴──────────────────────┤
│  📁 ファイルブラウザへ  |  📊 810文書登録済み   │
└─────────────────────────────────────────────┘
```

## 10. ドキュメント取り込みパイプライン

```
ファイル → テキスト抽出 → チャンク分割 → Embedding生成 → DB保存
                │
                ├─ .md  → そのまま
                ├─ .pdf → PyMuPDF でテキスト抽出
                └─ .docx → python-docx でテキスト抽出
```

### チャンク分割
- サイズ: 512トークン（約800文字）
- オーバーラップ: 64トークン
- 区切り: 段落・見出し優先

### wiki_sync連携
既存の wiki_sync パイプラインで変換済みMDファイルを一括取り込み：
```
wiki_sync/data/converted/*.md → POST /api/ingest/wiki-sync
```

## 11. Redis PubSub

### 用途
| 機能 | 説明 |
|------|------|
| SSEブロードキャスト | マルチワーカー環境でAI回答ストリームを正しいクライアントに配信 |
| セッション管理 | JWTトークン無効化リスト（ログアウト/強制切断） |
| ジョブキュー | 文書取り込み（パース＋embedding）のバックグラウンド処理 |
| 取り込み進捗通知 | 一括取り込みの進捗をリアルタイムでフロントエンドに通知 |

### チャネル設計
```
las:ai:stream:{request_id}     -- AI回答ストリーム（リクエスト単位）
las:ingest:progress:{job_id}   -- 取り込み進捗
las:ingest:queue                -- 取り込みジョブキュー
las:session:blacklist           -- 無効化済みトークン
```

## 12. Docker構成

```yaml
services:
  db:
    image: pgvector/pgvector:pg18
    # pg_bigm は Dockerfile でビルド or 拡張インストール
    environment:
      POSTGRES_USER: las
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: las
    volumes:
      - las_db:/var/lib/postgresql/data/

  redis:
    image: redis:7-alpine
    volumes:
      - las_redis:/data

  backend:
    build: ./backend
    depends_on: [db, redis]
    volumes:
      - las_storage:/app/storage
      - /tmp/las.sock:/tmp/las.sock
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - DATABASE_URL=postgresql://las:${POSTGRES_PASSWORD}@db:5432/las
      - REDIS_URL=redis://redis:6379/0
      - LLM_URL=http://host.docker.internal:8081/v1
      - EMBED_URL=http://host.docker.internal:8082/v1
      - JWT_SECRET=${JWT_SECRET}
    command: >
      gunicorn app.main:app
      -w 4
      -k uvicorn.workers.UvicornWorker
      --bind unix:/tmp/las.sock

  nginx:
    image: nginx:alpine
    ports: ["3001:80", "3443:443"]
    depends_on: [backend]
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./frontend/dist:/usr/share/nginx/html:ro
      - /tmp/las.sock:/tmp/las.sock
      # - ./nginx/certs:/etc/nginx/certs:ro  # SSL証明書

volumes:
  las_db:
  las_redis:
  las_storage:
```

llama.cpp サーバー（:8081, :8082）は既存のsystemdサービスをそのまま利用。

## 13. ディレクトリ構成

```
local-ai-search/
├── docs/                    -- 設計書（本文書）
├── backend/
│   ├── app/
│   │   ├── main.py          -- FastAPI エントリポイント
│   │   ├── config.py        -- 設定
│   │   ├── models.py        -- SQLAlchemy モデル
│   │   ├── routers/
│   │   │   ├── auth.py      -- 認証API（ログイン/トークン更新）
│   │   │   ├── users.py     -- ユーザー管理API
│   │   │   ├── search.py    -- 検索API
│   │   │   ├── documents.py -- 文書管理API
│   │   │   ├── files.py     -- ファイルブラウザAPI
│   │   │   └── ingest.py    -- 取り込みAPI
│   │   ├── services/
│   │   │   ├── auth.py      -- JWT発行/検証, 権限チェック
│   │   │   ├── search.py    -- 全文＋ベクトル検索ロジック
│   │   │   ├── ai_agent.py  -- AI自律検索（ReAct）
│   │   │   ├── embedding.py -- embedding生成
│   │   │   ├── pubsub.py    -- Redis PubSub ラッパー
│   │   │   └── parser.py    -- ファイルパーサー
│   │   ├── deps.py          -- 依存性注入（認証, DB）
│   │   └── db.py            -- DB接続
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── SearchPage.tsx
│   │   │   ├── FileBrowser.tsx
│   │   │   ├── DocumentView.tsx
│   │   │   ├── LoginPage.tsx
│   │   │   └── AdminPage.tsx  -- ユーザー/ロール管理
│   │   └── components/
│   │       ├── SearchBar.tsx
│   │       ├── ResultList.tsx
│   │       ├── AIAnswer.tsx
│   │       └── FileTree.tsx
│   ├── package.json
│   └── vite.config.ts
├── nginx/
│   └── nginx.conf
└── docker-compose.yml
```

## 14. 実装フェーズ

### Phase 1: 基盤（MVP）
- [ ] PostgreSQL 18 + pgvector + pg_bigm セットアップ
- [ ] Redis セットアップ
- [ ] FastAPI バックエンド骨格 (Gunicorn + Uvicorn)
- [ ] 認証基盤（JWT, ユーザーCRUD, ロール）
- [ ] ドキュメント取り込み（MD）
- [ ] 全文検索 + ベクトル検索 API
- [ ] 最小限の検索UI + ログイン画面
- [ ] Nginx リバースプロキシ

### Phase 2: AI統合
- [ ] AI回答生成（単発RAG）
- [ ] SSEストリーミング（Redis PubSub経由）
- [ ] ReAct自律検索（複数回検索）
- [ ] 検索結果マージ（RRF）
- [ ] 権限フィルタ付き検索

### Phase 3: UI完成
- [ ] ファイルブラウザ
- [ ] PDF/DOCXプレビュー
- [ ] 文書詳細表示
- [ ] 管理画面（ユーザー管理、ロール管理、権限設定）

### Phase 4: 運用
- [ ] wiki_sync連携（自動取り込み）
- [ ] PDF/DOCX対応
- [ ] Docker Compose 本番構成完成
- [ ] SSL/TLS対応
- [ ] パフォーマンスチューニング

## 15. 既存インフラ活用

| リソース | 状態 | LASでの利用 |
|---------|------|------------|
| llama.cpp :8081 (qwen3.5-35b-a3b) | 稼働中 | LLM推論 |
| llama.cpp :8082 (bge-m3) | 稼働中 | Embedding生成 |
| wiki_sync 変換済みMD 810件 | 利用可能 | 初期データ投入 |
| PostgreSQL (Khoj/RagFlow用) | 停止可能 | LAS専用DBに置換 |
