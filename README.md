# LAS — Local AI Search

**「あのファイルどこだっけ？」を終わらせる、セルフホストファイル検索サーバー**

ファイルが増えると、必要な文書が見つからなくなる。ファイル名の部分一致だけでは限界がある。「あの件の資料」のような曖昧な記憶では何も出てこない。

LAS は全文検索とベクトル検索（意味検索）を組み合わせ、キーワードが正確に一致しなくても内容が近いファイルを見つけ出します。PDF・画像も OCR で自動テキスト化して検索対象に。データはローカルから一切外に出ません。

## セキュリティ設計

LAS はセキュリティを最優先に設計されています。

### データがローカルから出ない

LAS 本体は **LAN 内で完結** し、インターネットに公開しません。ファイル、検索インデックス、AI処理の全てがローカルで実行されます。クラウドサービスへのデータ送信はゼロ。LLM・Embedding・OCR も全てローカル GPU で動作します。

### 多層防御

| レイヤー | 保護内容 |
|---------|---------|
| **ウイルススキャン** | ClamAV（360万+シグネチャ）でアップロード時に自動スキャン。感染ファイルは即座に削除、処理を中止 |
| **Unix パーミッション** | ドキュメント・フォルダ単位で owner / group / others の read / write を制御。管理者は全アクセス可 |
| **認証** | JWT アクセストークン + リフレッシュトークン。API キーはフォルダスコープ + 権限制限付き |
| **レジューマブルアップロード** | tus プロトコルで大容量ファイルも安全に転送。中断しても途中から再開、ファイル破損なし |

### 外部共有の安全な設計

外部ユーザーへのファイル共有が必要な場合でも、LAS 本体を公開する必要はありません。

```
LAN 内（非公開）              インターネット（公開）
┌──────────┐  ファイル転送   ┌──────────────┐
│ LAS 本体 │ ────────────→ │ Share Server │ ← 外部ユーザーがアクセス
│          │  （一方向のみ） │ (独立サーバー) │
└──────────┘               └──────────────┘
```

- **一方向転送**: LAS → Share Server のみ。Share Server から LAS へのアクセス経路は存在しない
- **Share Server が侵害されても LAS 本体のデータに到達不可能**
- **有効期限必須（最大30日）**: 期限切れファイルは自動削除。ファイルが永久に残らない
- **パスワード保護**: オプションで共有リンクにパスワードを設定可能
- **Share Server は独立デプロイ**: LAS とは別のサーバー・ネットワークに配置。Go バイナリ + SQLite で超軽量

## 機能一覧

| 機能 | 説明 |
|------|------|
| AI エージェント検索 | ツール呼び出しで自律的に文書を探索・回答 |
| ベクトル検索（意味検索） | 「この内容に似た文書」を発見 |
| 全文 + ベクトル RRF統合検索 | ハイブリッドで精度最大化 |
| OCR テキスト抽出 | 画像・スキャンPDF を自動処理して検索可能に |
| ドキュメント自動要約 | LLM で要約を自動生成 |
| 全ファイルタイプ対応 | テキスト抽出・動画音声プレビュー・メタ情報検索の3層分類 |
| LibreOffice プレビュー | PPTX/DOCX/DOC/RTF をページ画像に変換してプレビュー |
| 動画プレビュー (video.js v10) | mp4/mov/mkv/avi 等主要フォーマット対応 |
| 音声プレビュー | mp3/wav/ogg/m4a/flac/aac をブラウザ内再生 |
| tus レジューマブルアップロード | 中断しても途中から再開可能 |
| ClamAV ウイルススキャン | アップロード時に自動スキャン |
| WYSIWYG テキスト編集 | OverType エディタで検索用テキストを修正 |
| 外部共有リンク | 独立した Share Server 経由で安全にファイル共有 |
| API キー外部連携 | フォルダスコープ + 権限制限付き |
| 共有・ダウンロード制御 | ユーザー単位・ファイル単位で禁止フラグ設定可能 |
| メール通知 | ログイン・追加・更新・削除をメールで通知（SMTP/SendGrid/Resend/SES対応） |
| 監査ログ | 全操作記録、フィルタ、CSVエクスポート |
| お気に入り | ユーザー別スター登録、サイドバーからクイックアクセス |
| フォルダアップロード | ドラッグ&ドロップでフォルダ階層を自動作成 |
| アップロードキュー | 大量ファイルを同時3件制限で順次アップロード、進捗パネル表示 |
| バージョン管理 | アップロード時にv1自動作成、編集・上書きで自動バージョン追加、任意バージョンへ復元 |
| ノート (Wiki) | BlockNote WYSIWYG エディタ、ツリー構造、ドラッグ&ドロップ並べ替え、Yjs リアルタイム共同編集 |
| 完全ローカル | データはクラウドに送信されません |

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
- **フォルダアップロード** — ドラッグ&ドロップでフォルダ階層を自動作成して配置。隠しディレクトリ(.git等)は自動除外
- **アップロードキュー** — 大量ファイル（最大1000件）を同時3件制限で順次アップロード。バッチ進捗パネル、一括中止、エラースキップ対応
- **ClamAV ウイルススキャン** — アップロード時に自動スキャン、感染ファイルは即削除
- **全ファイルタイプ対応** — あらゆるファイルをアップロード可能。テキスト抽出対応(MD/PDF/DOCX/XLSX/CSV/HTML/PPTX/RTF/画像OCR)、動画・音声はブラウザ内プレビュー、その他ファイルもメタ情報で検索可能
- **LibreOffice プレビュー** — PPTX/DOCX/DOC/RTF をアップロード時に LibreOffice headless で PDF 変換 → ページ画像生成。Excel/CSV は表形式 HTML プレビュー
- **動画プレビュー** — video.js v10 でmp4/mov/mkv/avi等を再生（シーク、再生速度、PiP、フルスクリーン対応）
- **音声プレビュー** — mp3/wav/ogg/m4a/flac/aac をブラウザ内再生
- **テキスト編集** — OverType エディタでOCR誤認識の修正等（再チャンク・再ベクトル化を自動実行）
- **AI 要約** — 文書登録時に LLM で要約を自動生成
- **外部共有リンク** — LAN内のファイルを外部の Share Server 経由で共有。パスワード保護、有効期限（最大30日）、期限切れ自動削除対応
- **一括操作** — 複数選択でタグ編集、フォルダ移動、権限変更、削除、Zip ダウンロード
- **ゴミ箱** — ソフトデリート + 復元 + 完全削除
- **お気に入り** — スター登録でクイックアクセス。サイドバー・右クリックメニュー・モーダルから操作、ユーザーごとに独立
- **バージョン管理** — アップロード時にv1自動作成。テキスト編集・ファイル上書き時に自動バージョン追加。変更種別（アップロード/テキスト編集/ファイル上書き）・変更者・日時を記録。任意のバージョンへ復元可能
- **ノート (Wiki)** — BlockNote WYSIWYG エディタでリッチテキスト編集。ツリー構造でノートを階層管理。ドラッグ&ドロップで並べ替え・親子関係変更。Yjs WebSocket によるリアルタイム共同編集（接続不可時はローカルモードにフォールバック）
- **キーボードショートカット** — Ctrl+A 全選択、Escape 解除、Delete ゴミ箱移動

### セキュリティ・権限

- **Unix スタイルパーミッション** — ドキュメント・フォルダ単位で owner / group / others の read / write 制御
- **管理者 / 一般ユーザー** — 管理機能（ユーザー/ロール/設定/APIキー/グループ管理）は admin のみ
- **グループ管理** — ユーザーをグループに所属させ、グループ単位でアクセス制御
- **JWT 認証** — アクセストークン + リフレッシュトークン
- **API キー** — 外部連携用、フォルダスコープ・権限制限付き

### 管理

- **管理画面** — ユーザー管理、ロール管理、グループ管理、APIキー管理、システム設定、メール通知、監査ログ
- **メール通知** — ログイン・ファイル追加・更新・削除をメールで通知。SMTP / SendGrid / Resend / AWS SES 対応。通知先ごとにイベント選択可能。バルク操作は自動集約して1通に
- **監査ログ** — ログイン・アップロード・削除・復元等の全操作を記録。ユーザー・操作種別・日時でフィルタ、CSVエクスポート
- **システム設定** — LLM/Embedding接続先、検索パラメータ等をUIから変更

## ファイル設計思想

LAS は**ファイルサーバー**であり、元ファイルは不可侵が原則。変更はアップロードによる上書きのみ。

```
元ファイル(disk) → テキスト抽出 → content(DB) → チャンク → 検索インデックス
```

- **メタデータ**（メモ、要約、権限、タグ）は DB に保持し、元ファイルを壊さない
- **検索テキスト**（`content`）は OCR 誤認識の補正等のために手動編集可能。編集しても元ファイルには影響しない
- **例外: `.md` ファイルのみ**、content = ファイル内容そのものであるため、検索テキスト編集・ノート編集時に元ファイルへ書き戻す
- **ノート化できるのは `.md` ファイルのみ**。新規ノート作成時も `.md` ファイルが生成される

詳細は [docs/file-content-design.md](docs/file-content-design.md) を参照。

## アーキテクチャ

```
 LAN 内（クローズド）
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

                     ┌──────────────────┐
                     │  Surya OCR       │  ← GPU (ROCm/CUDA) 推奨
                     │  :8090           │
                     └──────────────────┘

                                        │ ファイル転送 (共有時のみ)
                                        ▼
 インターネット（公開）   ┌──────────────────┐
                         │  Share Server     │  ← 別サーバーに独立デプロイ
                         │  Go + SQLite      │
                         └──────────┬───────┘
                                    ↑
                              外部ユーザー
```

**LAS 本体は LAN 内で完結（インターネット公開しない）。共有時のみ外部の Share Server にファイル転送。**

## Tech Stack

| レイヤー | 技術 |
|----------|------|
| Frontend | React 19 + TypeScript, Vite 7, shadcn/ui, TailwindCSS 4 |
| Backend | Python 3.12, FastAPI, Gunicorn + Uvicorn (4 workers) |
| DB | PostgreSQL 18 + pgvector (ベクトル検索) + pg_bigm (高速日本語全文検索) |
| Cache | Redis 7 |
| Upload | tusd (tus プロトコル — レジューマブルアップロード) |
| Antivirus | ClamAV (360万+シグネチャ、自動定義更新) |
| Share Server | Go + SQLite (WAL) — 外部共有専用、独立デプロイ |
| Document Preview | LibreOffice headless + PyMuPDF — PPTX/DOCX/DOC/RTF → PDF → PNG 変換 |
| OCR | Surya OCR — GPU対応（ROCm/CUDA）、画像・スキャンPDFのテキスト抽出 |
| Text Editor | OverType (91KB、依存ゼロの WYSIWYG マークダウンエディタ) |
| Note Editor | BlockNote (ProseMirror ベース WYSIWYG ブロックエディタ) |
| Collaboration | Yjs + y-websocket (CRDT リアルタイム共同編集、LevelDB 永続化) |
| Video Player | video.js v10 (@videojs/react) — リッチな動画プレイヤー |
| LLM | llama.cpp (OpenAI 互換 API) |
| Embedding | llama.cpp (OpenAI 互換 API) |
| Proxy | Nginx (SPA + API + tus リバースプロキシ) |
| Container | Docker Compose |

## セットアップ

### 前提条件

- Docker + Docker Compose
- llama.cpp サーバー 2台（LLM用 / Embedding用）
- Node.js 20+ (フロントエンドビルド用)
- OCR サーバー（オプション、画像・スキャンPDF対応時に必要）

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

### OCR サーバーの起動（オプション）

Surya OCR を使った画像・スキャンPDFのテキスト抽出サーバー。GPU（ROCm/CUDA）推奨。

```bash
cd ocr-server

# Python venv 作成 + 依存インストール
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 起動（デフォルト: ポート 8090、GPU使用）
./start.sh

# CPU モードで起動する場合
TORCH_DEVICE=cpu ./start.sh
```

OCR サーバーが起動していない場合、画像ファイルのテキスト抽出とスキャンPDFの OCR はスキップされます（テキスト埋め込みPDFは OCR なしで処理可能）。

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
| y-websocket | Yjs WebSocket サーバー（共同編集） | 内部 1234 |
| nginx | リバースプロキシ + SPA 配信 | **3002** |
| ocr-server | Surya OCR（ホスト直接起動） | 8090 |

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
4. クリーン判定 → テキスト抽出対応ファイル(Tier 1)はテキスト抽出 → チャンク分割 → ベクトル化 → 要約生成
5. 動画・音声等(Tier 2/3)は処理スキップ、即完了（メタ情報で検索可能）
6. 感染検出 → ファイル即削除、エラー記録

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
| GET | `/api/documents/{id}/versions` | バージョン一覧 |
| POST | `/api/documents/{id}/versions/{n}/restore` | バージョン復元 |
| DELETE | `/api/documents/{id}` | 文書削除 (ソフトデリート) |
| POST | `/api/documents/bulk-action` | 一括操作 |
| POST | `/api/documents/download-zip` | 複数ファイルZipダウンロード |
| GET | `/api/documents/filter-options` | フィルタ選択肢（種別・登録者） |
| GET | `/api/favorites` | お気に入り一覧 |
| POST | `/api/favorites/{id}` | お気に入り追加 |
| DELETE | `/api/favorites/{id}` | お気に入り解除 |
| GET | `/api/folders` | フォルダ一覧 |
| POST | `/api/folders/bulk` | フォルダ階層一括作成 |
| GET | `/api/tags` | タグ一覧 |
| POST | `/api/ingest/tus-hook` | tus アップロード完了フック |
| GET | `/api/users` | ユーザー一覧 (admin) |
| GET | `/api/settings` | システム設定 (admin) |
| GET | `/api/api-keys` | APIキー一覧 (admin) |
| GET | `/api/groups` | グループ一覧 |
| GET | `/api/admin/mail/recipients` | メール通知先一覧 (admin) |
| POST | `/api/admin/mail/recipients` | メール通知先追加 (admin) |
| PATCH | `/api/admin/mail/recipients/{id}` | メール通知先更新 (admin) |
| DELETE | `/api/admin/mail/recipients/{id}` | メール通知先削除 (admin) |
| POST | `/api/admin/mail/test` | テストメール送信 (admin) |
| GET | `/api/admin/audit-logs` | 監査ログ一覧 (admin) |
| GET | `/api/notes` | ノートツリー取得 |
| POST | `/api/notes` | ノート新規作成 |
| GET | `/api/notes/{id}` | ノート詳細取得 |
| PATCH | `/api/notes/{id}` | ノート更新（タイトル・内容） |
| PATCH | `/api/notes/{id}/move` | ノート移動・並べ替え |
| POST | `/api/notes/from-document/{id}` | 既存 .md ファイルをノート化 |
| POST | `/api/notes/{id}/remove` | ノート解除（ファイルは残る） |
| POST | `/api/notes/{id}/delete-with-file` | ノートとファイルを削除 |
| GET | `/api/admin/audit-logs/export` | 監査ログCSVエクスポート (admin) |

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

#### ファイルアップロード

```bash
curl -X POST https://your-server/api/ingest/upload \
  -H "X-API-Key: las_xxx" \
  -F "file=@document.pdf" \
  -F "folder_id=FOLDER_UUID"  # 省略可
```

#### テキスト投入（n8n / Zapier 連携向け）

```bash
curl -X POST https://your-server/api/ingest/content \
  -H "X-API-Key: las_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "タイトル",
    "content": "本文テキスト（Markdown可）",
    "source": "notion",
    "external_id": "page-id-123",
    "external_url": "https://notion.so/...",
    "folder": "Notion/プロジェクトA",
    "tags": ["notion", "sync"],
    "memo": "メモ",
    "mode": "append",
    "version": true
  }'
```

`source` + `external_id` が同じ場合は既存ドキュメントを更新（upsert）。

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| `title` | ○ | ドキュメントタイトル（`.md` 自動付与） |
| `content` | ○ | 本文（Markdown 形式） |
| `source` | ○ | 登録元の識別子（例: `discord`, `jira`, `notion`） |
| `external_id` | | 外部サービスの一意 ID（upsert キー） |
| `external_url` | | 外部サービスの URL |
| `folder` | | フォルダ名（自動作成）。`/` 区切りでサブフォルダ指定可（例: `親/子/孫`） |
| `tags` | | タグ名の配列（自動作成） |
| `memo` | | メモ |
| `mode` | | `"append"`: 既存ドキュメントに追記。省略時は全文置換 |
| `version` | | `true`: 更新時にバージョンを保存。デフォルト `false` |

#### その他のエンドポイント

| メソッド | エンドポイント | 説明 |
|---------|--------------|------|
| GET | `/api/ingest/status/{id}` | 処理状況の確認 |
| DELETE | `/api/ingest/{id}` | ドキュメント削除（`delete` 権限が必要） |
| GET | `/api/ingest/list` | ドキュメント一覧 |

## 設計書

- [共有リンク設計](docs/share-links.md) — Share Server アーキテクチャ, API 仕様
- [汎用ファイルアップロード設計](docs/universal-file-upload.md) — tus, ClamAV, 全ファイルタイプ対応
- [将来機能ロードマップ](docs/future-features.md) — バージョン管理, AI自動整理, ストレージクォータ, S3連携
- [ファイルとコンテンツの設計思想](docs/file-content-design.md) — 元ファイル不可侵の原則, .md 特別扱いの経緯
- [ノート機能設計](docs/design-notes.md) — ノート機能の設計, Yjs 共同編集
- [リファクタリング](REFACTOR.md) — 権限モデル調査結果, 残タスク

## Share Server

LAN 内のファイルを外部ユーザーに共有するための独立サーバー。
Go + SQLite で動作し、LAS 本体とは別にデプロイする。

### セットアップ

```bash
cd share-server

# 環境変数設定
cp .env.example .env
# .env を編集: SHARE_BASE_URL, SHARE_JWT_SECRET を設定

# 起動
docker compose up -d
```

### API キーの作成

LAS 本体との通信に必要な API キーを作成:

```bash
# Docker 内で CLI 実行
docker compose exec share share-server key create --name "本社LAS"
# => Key: sk_xxxxx (この値を LAS 管理画面の share_server_api_key に設定)
```

### CLI コマンド一覧

```bash
# API キー管理
docker compose exec share share-server key create --name "名前"
docker compose exec share share-server key list
docker compose exec share share-server key revoke <id>

# 共有リンク管理
docker compose exec share share-server links
docker compose exec share share-server links delete <token>

# ステータス確認
docker compose exec share share-server status

# 期限切れファイルの手動クリーンアップ
docker compose exec share share-server cleanup
```

### LAS 本体との接続

1. Share Server で API キーを作成
2. LAS 管理画面で以下を設定:
   - `share_server_url`: Share Server の URL（例: `https://share.example.com`）
   - `share_server_api_key`: 作成した API キー
3. 「接続テスト」ボタンで確認 → 成功すると共有機能が自動的に有効化

### 共有の流れ

1. LAS でドキュメントを右クリック → 「共有リンク作成」
2. 有効期限（1時間〜30日）とパスワード（オプション）を設定
3. LAS が Share Server にファイルを転送、共有 URL を取得
4. URL を外部ユーザーに送る
5. 外部ユーザーが URL にアクセス → ダウンロード
6. 期限切れのファイルは Share Server が自動削除

## ライセンス

AGPL-3.0

このソフトウェアは GNU Affero General Public License v3.0 の下で提供されます。
ネットワーク経由でサービスとして提供する場合も、ソースコードの公開が必要です。

企業向けの商用ライセンス（サポート・SLA・カスタマイズ含む）については別途お問い合わせください。
