# LAS — Local AI Search

**AI搭載のローカルファイル管理・検索システム**

クラウドに一切データを送らず、ローカル環境で完結する企業向けファイル管理システム。全文検索・ベクトル検索・AIエージェントによる自律的な文書探索を統合し、商用NASにはない知的検索体験を実現する。

## 商用NASにない機能

| 機能 | Synology / QNAP | LAS |
|------|:---:|:---:|
| AI エージェント検索 | ✗ | ✓ ツール呼び出しで自律的に文書を探索・回答 |
| ベクトル検索（意味検索） | ✗ | ✓ 「この内容に似た文書」を発見 |
| 全文 + ベクトル RRF統合検索 | ✗ | ✓ ハイブリッドで精度最大化 |
| OCR → 自動テキスト化 → 検索可能 | △ | ✓ 画像・PDF を自動処理 |
| ドキュメント自動要約 | ✗ | ✓ LLM で要約を自動生成 |
| tus レジューマブルアップロード | ✗ | ✓ 中断しても途中から再開 |
| ClamAV ウイルススキャン | △ | ✓ アップロード時に自動スキャン |
| WYSIWYG テキスト編集 | ✗ | ✓ OverType エディタ（検索用テキスト修正） |
| API キーによる外部連携 | △ | ✓ フォルダスコープ付き |
| 完全ローカル（データ外部送信ゼロ） | ✓ | ✓ |

## 主な機能

### 検索・AI

- **ハイブリッド検索** — pg_bigm 全文検索 + pgvector ベクトル検索を並列実行、RRF でスコア統合
- **日本語形態素解析** — Janome で自然文クエリを自動分解
- **AI 自律検索エージェント** — ReAct 方式で search / grep / read_document 等のツールを自律的に使い回答生成
- **SSE ストリーミング** — AI 回答・ツール実行状況をリアルタイム表示
- **フィルタ** — ファイルタイプ、更新日範囲、登録者で絞り込み

### ファイル管理

- **ファイルエクスプローラー** — フォルダ階層、タグ、ドラッグ&ドロップ整理
- **tus レジューマブルアップロード** — 大容量ファイル対応、中断再開可能、進捗率リアルタイム表示
- **ClamAV ウイルススキャン** — アップロード時に自動スキャン、感染ファイルは即削除
- **マルチフォーマット対応** — Markdown / PDF / DOCX / XLSX / CSV / HTML / PPTX / 画像(OCR)
- **テキスト編集** — OverType エディタでOCR誤認識の修正等（再チャンク・再ベクトル化を自動実行）
- **AI 要約** — 文書登録時に LLM で要約を自動生成
- **一括操作** — 複数選択でタグ編集、フォルダ移動、権限変更、削除、Zip ダウンロード
- **ゴミ箱** — ソフトデリート + 復元 + 完全削除
- **キーボードショートカット** — Ctrl+A 全選択、Escape 解除、Delete ゴミ箱移動

### セキュリティ・権限

- **Unix スタイルパーミッション** — ドキュメント・フォルダ単位で owner / group / others の read / write 制御
- **管理者 / 一般ユーザー** — 管理機能（ユーザー/ロール/設定/APIキー/グループ管理）は admin のみ
- **グループ管理** — ユーザーをグループに所属させ、グループ単位でアクセス制御
- **JWT 認証** — アクセストークン + リフレッシュトークン
- **API キー** — 外部連携用、フォルダスコープ・権限制限付き

### 管理

- **管理画面** — ユーザー管理、ロール管理、グループ管理、APIキー管理、システム設定
- **システム設定** — LLM/Embedding接続先、検索パラメータ等をUIから変更

## アーキテクチャ

```
┌──────────────┐     ┌─────────┐     ┌──────────────────────┐
│   Browser    │────▶│  Nginx  │────▶│  FastAPI Backend      │
│  (React SPA) │◀────│  :3002  │◀────│  (Gunicorn + Uvicorn) │
└──────────────┘     └────┬────┘     └──────────┬───────────┘
                          │                      │
                     ┌────▼────┐    ┌────────────┼────────────────────┐
                     │  tusd   │    │            │                    │
                     │  (tus)  │    ▼            ▼                   ▼
                     └─────────┘  ┌──────────┐ ┌───────┐ ┌──────────────────┐
                                  │PostgreSQL│ │ Redis │ │   llama.cpp      │
                     ┌─────────┐  │ pgvector │ │       │ │ LLM + Embedding  │
                     │ ClamAV  │  │ pg_bigm  │ │       │ │                  │
                     └─────────┘  └──────────┘ └───────┘ └──────────────────┘
```

**全てローカルで完結。クラウドへのデータ送信ゼロ。**

## Tech Stack

| レイヤー | 技術 |
|----------|------|
| Frontend | React 19 + TypeScript, Vite 7, shadcn/ui, TailwindCSS 4 |
| Backend | Python 3.12, FastAPI, Gunicorn + Uvicorn (4 workers) |
| DB | PostgreSQL 18 + pgvector (ベクトル検索) + pg_bigm (高速日本語全文検索) |
| Cache | Redis 7 |
| Upload | tusd (tus プロトコル — レジューマブルアップロード) |
| Antivirus | ClamAV (360万+シグネチャ、自動定義更新) |
| Text Editor | OverType (91KB、依存ゼロの WYSIWYG マークダウンエディタ) |
| LLM | llama.cpp (OpenAI 互換 API) |
| Embedding | llama.cpp (OpenAI 互換 API) |
| Proxy | Nginx (SPA + API + tus リバースプロキシ) |
| Container | Docker Compose |

## セットアップ

### 前提条件

- Docker + Docker Compose
- llama.cpp サーバー 2台（LLM用 / Embedding用）
- Node.js 20+ (フロントエンドビルド用)

### llama.cpp サーバーの起動

**LLM サーバー (ポート 8081)**

```bash
llama-server \
  -m <model.gguf> \
  --host 0.0.0.0 --port 8081 \
  -ngl 99 -c 32768 --parallel 4 --reasoning-budget 0
```

**Embedding サーバー (ポート 8082)**

```bash
llama-server \
  -m <embedding-model.gguf> \
  --host 0.0.0.0 --port 8082 \
  --embedding -ngl 99 -c 32768 --parallel 4
```

### 起動手順

```bash
git clone <repository-url>
cd local-ai-search

# 環境変数設定
cp .env.example .env
# .env を編集: POSTGRES_PASSWORD, JWT_SECRET を変更

# フロントエンドビルド
cd frontend && npm install && npm run build && cd ..

# 起動
docker compose up -d
```

### サービス一覧

| サービス | 説明 | ポート |
|----------|------|--------|
| db | PostgreSQL 18 (pgvector + pg_bigm) | 内部 |
| redis | Redis 7 | 内部 |
| backend | FastAPI アプリケーション | 内部 8000 |
| tusd | tus アップロードサーバー | 内部 8080 |
| clamav | ClamAV ウイルススキャン | 内部 3310 |
| nginx | リバースプロキシ + SPA 配信 | **3002** |

### 初回ログイン

`http://localhost:3002` にアクセス。

- ユーザー名: `admin`
- パスワード: `admin`

**初回ログイン後、必ずパスワードを変更してください。**

### LLM / Embedding 設定

管理画面の「設定」タブで接続先を確認:

| 設定キー | デフォルト値 | 説明 |
|----------|-------------|------|
| `llm_url` | `http://host.docker.internal:8081/v1` | LLM サーバー URL |
| `llm_model` | `qwen3.5-35b-a3b` | LLM モデル名 |
| `embed_url` | `http://host.docker.internal:8082/v1` | Embedding サーバー URL |
| `embed_model` | `bge-m3` | Embedding モデル名 |

## 検索の仕組み

### ハイブリッド検索 (RRF)

1. **全文検索** (pg_bigm) — Janome で形態素解析、名詞抽出、GIN インデックスで高速 LIKE
2. **ベクトル検索** (pgvector) — クエリを Embedding でベクトル化、コサイン類似度で検索
3. **RRF マージ** — `score = 1/(k+rank)` で両結果を統合、文書単位で重複排除

### AI エージェント (ReAct)

LLM が以下のツールを自律的に使って情報を収集し、日本語で回答を生成:

| ツール | 説明 |
|--------|------|
| `search` | キーワード + 意味検索 (RRF) |
| `grep` | テキストパターン部分一致検索 |
| `search_by_title` | タイトル・ファイル名検索 |
| `read_document` | 文書 ID で全文取得 |
| `count_results` | 検索ヒット件数確認 |

## アップロードの仕組み

[tus プロトコル](https://tus.io/) によるレジューマブルアップロード:

1. ファイルを5MBチャンクに分割してアップロード
2. 中断しても途中から再開可能（ブラウザ再起動後も）
3. アップロード完了 → ClamAV でウイルススキャン
4. クリーン判定 → テキスト抽出 → チャンク分割 → ベクトル化 → 要約生成
5. 感染検出 → ファイル即削除、エラー記録

API キーからも tus 経由でアップロード可能（curl, Python 等）。

## 運用

```bash
# バックエンド再ビルド
docker compose up -d --build backend

# フロントエンド再ビルド
cd frontend && npm run build

# ログ確認
docker compose logs backend --tail 50
docker compose logs -f backend  # リアルタイム

# ClamAV 定義更新状況
docker compose logs clamav | grep "database"

# テスト実行
docker compose exec backend python -m pytest tests/ -v
```

## API

| メソッド | パス | 説明 |
|----------|------|------|
| POST | `/api/auth/login` | ログイン |
| GET | `/api/auth/me` | 現在のユーザー情報 |
| GET | `/api/search?q=...` | ハイブリッド検索 |
| GET | `/api/search/documents?q=...` | 文書一覧形式の検索結果 |
| POST | `/api/chat/stream` | AI チャット (SSE) |
| GET | `/api/documents` | 文書一覧（フィルタ対応） |
| GET | `/api/documents/{id}` | 文書詳細 |
| PATCH | `/api/documents/{id}` | 文書更新（テキスト編集含む） |
| DELETE | `/api/documents/{id}` | 文書削除 (ソフトデリート) |
| POST | `/api/documents/bulk-action` | 一括操作 |
| POST | `/api/documents/download-zip` | 複数ファイルZipダウンロード |
| GET | `/api/documents/filter-options` | フィルタ選択肢（種別・登録者） |
| GET | `/api/folders` | フォルダ一覧 |
| GET | `/api/tags` | タグ一覧 |
| POST | `/api/ingest/tus-hook` | tus アップロード完了フック |
| GET | `/api/users` | ユーザー一覧 (admin) |
| GET | `/api/settings` | システム設定 (admin) |
| GET | `/api/api-keys` | APIキー一覧 (admin) |
| GET | `/api/groups` | グループ一覧 |

### API キーによる外部連携

```bash
# tus プロトコルでアップロード（レジューマブル）
# Step 1: アップロード開始
curl -X POST https://your-server/tusd/ \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(wc -c < file.pdf)" \
  -H "Upload-Metadata: filename $(echo -n 'file.pdf' | base64),api_key $(echo -n 'las_xxx' | base64)"

# Step 2: データ送信（レスポンスのLocationヘッダーのURLに対して）
curl -X PATCH https://your-server/tusd/<upload-id> \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @file.pdf
```

## 設計書

- [汎用ファイルアップロード設計](docs/universal-file-upload.md) — tus, ClamAV, 全ファイルタイプ対応
- [将来機能ロードマップ](docs/future-features.md) — バージョン管理, 共有リンク, AI自動整理, 監査ログ, S3連携
- [リファクタリング](REFACTOR.md) — 権限モデル調査結果, 残タスク

## ライセンス

MIT
