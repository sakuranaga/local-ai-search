# DB-Based Generic Job Queue

## Context

現在のドキュメント処理は `asyncio.Queue` を gunicorn ワーカー内で使用しており、以下の問題がある:
- 4つの gunicorn プロセスに独立したキューが存在し、ジョブ状態を共有できない
- フロントエンドからの進捗ポーリングが機能しない（別プロセスに当たると状態が見えない）
- 再起動でキュー内タスクが消失
- 今後のファイル処理系ジョブにも汎用的に使える基盤が必要

## 方針

PostgreSQL の `jobs` テーブル + `FOR UPDATE SKIP LOCKED` による汎用ジョブキュー。専用ワーカープロセスを分離。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `backend/app/models.py` | `Job` モデル追加 |
| `backend/app/services/job_queue.py` | **新規** — create_job, claim_job, update_progress, complete_job, fail_job |
| `backend/app/worker.py` | **新規** — 独立ワーカープロセス（DB ポーリング） |
| `backend/app/routers/jobs.py` | **新規** — `GET /api/jobs/{id}`, `GET /api/jobs?ids=` |
| `backend/app/main.py` | jobs ルーター登録、`start_workers()` 削除 |
| `backend/app/services/document_processing.py` | `process_document_background_job()` 追加、旧 asyncio.Queue コード削除 |
| `backend/app/routers/ingest.py` | `enqueue_processing()` → `create_job()` (3箇所) |
| `backend/app/routers/documents.py` | `enqueue_processing()` → `create_job()` / `create_jobs_bulk()` (3箇所) |
| `backend/app/services/versioning.py` | `enqueue_processing()` → `create_job()` (1箇所) |
| `docker-compose.yml` | `queue-worker` サービス追加 |
| `frontend/src/lib/api/documents.ts` | `pollReindexProgress` を jobs API ベースに変更 |

## 1. Job モデル (`backend/app/models.py`)

```python
class Job(Base):
    __tablename__ = "jobs"

    id            UUID PK default uuid4
    job_type      String(100) NOT NULL      # "document_processing", etc.
    payload       JSON NOT NULL default={}  # ジョブ固有の引数
    status        String(30) default="pending"  # pending/running/completed/failed
    progress      String(50) nullable       # "parsing", "embedding", "3/5" etc.
    error         Text nullable
    attempts      Integer default=0
    max_attempts  Integer default=3
    scheduled_at  DateTime default=now()
    started_at    DateTime nullable
    completed_at  DateTime nullable
    created_at    DateTime default=now()
    updated_at    DateTime default=now()

    Indexes: (status, scheduled_at), (job_type), (created_at)
```

## 2. Job Queue サービス (`backend/app/services/job_queue.py`)

- `create_job(db, job_type, payload)` → Job (flush のみ、caller が commit)
- `create_jobs_bulk(db, job_type, payloads)` → list[Job]
- `claim_job(db, job_types?)` → Job | None (`FOR UPDATE SKIP LOCKED`)
- `update_progress(db, job_id, progress)` → None
- `complete_job(db, job_id, result?)` → None
- `fail_job(db, job_id, error)` → retry 判定 (attempts < max_attempts → pending に戻す)
- `get_job(db, job_id)` / `get_jobs_by_ids(db, job_ids)`

## 3. ワーカープロセス (`backend/app/worker.py`)

- `python -m app.worker --concurrency 2 --poll-interval 1.0`
- ハンドラ登録パターン: `@register_handler("document_processing")`
- ワーカーループ: `claim_job()` → handler 実行 → `complete_job()` / `fail_job()`
- SIGTERM でグレースフルシャットダウン
- 起動時に running のまま放置されたジョブ（10分超）を pending に戻す

## 4. API エンドポイント (`backend/app/routers/jobs.py`)

- `GET /api/jobs/{job_id}` → `{ id, job_type, status, progress, error, created_at, started_at, completed_at }`
- `GET /api/jobs?ids=id1,id2,...` → `{ jobs: [...] }`

## 5. 既存呼び出し変更パターン

Before:
```python
enqueue_processing(doc.id, str(storage_path), file_type, filename)
```

After:
```python
job = await create_job(db, "document_processing", {
    "doc_id": str(doc.id),
    "storage_path": str(storage_path),
    "file_type": file_type,
    "filename": filename,
})
# commit は既存の db.commit() に含まれる
```

Bulk reindex は `create_jobs_bulk()` を使い、レスポンスに `job_ids` を含める。

## 6. document_processing.py の変更

- `process_document_background_job(job_id, doc_id, ...)` を追加
  - 既存の `process_document_background` と同じ5フェーズ
  - `_set_status()` に加えて `update_progress(db, job_id, status)` も呼ぶ
  - 例外は raise する（worker が catch して `fail_job()` を呼ぶ）
- 旧コード削除: `_processing_queue`, `_worker_tasks`, `start_workers()`, `enqueue_processing()`, `_processing_worker()`

## 7. Docker Compose

```yaml
queue-worker:
    build: ./backend
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgresql+asyncpg://las:${POSTGRES_PASSWORD}@db:5432/las
      STORAGE_PATH: /data/storage
    depends_on:
      db:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/data/storage
    command: python -m app.worker --concurrency 2 --poll-interval 1.0
```

## 8. フロントエンド

- bulk reindex / 単体 reindex のレスポンスに `job_ids` を含める
- `pollReindexProgress` を `GET /api/jobs?ids=...` ベースに変更
- モーダル/トーストの進捗表示は jobs API のステータスをポーリング

## 9. クリーンアップ（不要コードの削除）

### バックエンド
- `document_processing.py`: 旧 asyncio.Queue 関連コード全削除
  - `_NUM_WORKERS`, `_processing_queue`, `_worker_tasks`
  - `enqueue_processing()`, `_processing_worker()`, `start_workers()`
  - 旧 `process_document_background()` (新 `_job` 版に置き換え後)
- `main.py`: `from app.services.document_processing import start_workers` と `start_workers()` 呼び出し削除
- `ingest.py`: `enqueue_processing` の import 削除
- `documents.py`: `enqueue_processing` の import 削除
- `versioning.py`: `enqueue_processing` の import 削除

### フロントエンド
- `documents.ts`: 旧 `pollReindexProgress` の `getDocumentStatus` ベースのポーリング削除（jobs API に置き換え）
- `FileExplorerPage.tsx`: `bulkReindexing` state が残っていれば削除
- `DocumentDetailModal.tsx`: 旧 `pollReindexProgress` の呼び出しを jobs API ベースに変更

## 10. 実装時の注意事項（実装中に発覚した問題）

### SQLAlchemy の `result` カラム名衝突
`Job` モデルに `result` という属性があると、`update(Job).values(result=...)` で SQLAlchemy の `CompileError: Unconsumed column names: result` が発生する。`update().values()` のキーワード引数ではなく、オブジェクト操作（`job.result = value`）で更新する必要がある。

### queue-worker は backend と別イメージ
`docker-compose.yml` で同じ `build: ./backend` を指定しても、Docker Compose はサービスごとに別イメージを管理する。コード変更時は `docker compose build backend queue-worker` で**両方ビルド**が必要。

### nginx の DNS キャッシュ
backend コンテナを `up -d` で再作成すると IP が変わるが、nginx がキャッシュした古い IP を参照して 502 になる。backend 再作成後は `docker compose restart nginx` が必要。

### FastAPI のトレイリングスラッシュリダイレクト
`@router.get("/")` は `/api/jobs` を `/api/jobs/` に 307 リダイレクトし、HTTPS 環境では `http://` にリダイレクトされて Mixed Content エラーになる。`router = APIRouter(redirect_slashes=False)` と `@router.get("")` で回避。

### jobs テーブルの作成タイミング
`queue-worker` が `backend` より先に起動すると `jobs` テーブルが未作成で `UndefinedTableError` になる。`restart: unless-stopped` で自動復旧するが、初回は手動で `docker compose restart queue-worker` が必要な場合がある。

## 検証手順

1. `docker compose build backend queue-worker` でイメージビルド（**両方必須**）
2. `docker compose up -d` で worker コンテナ起動確認
3. `docker compose logs queue-worker` でワーカー起動ログ確認
4. WebUI からファイルアップロード → `processing_status` が遷移することを確認
5. WebUI から一括ベクトル再構築 → トーストで進捗表示を確認
6. `docker compose restart queue-worker` → キュー内ジョブが失われないことを確認
7. ワーカー停止中にアップロード → ワーカー再開後に処理されることを確認
