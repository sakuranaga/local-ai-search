# 将来機能ロードマップ

## ビジョン

AI搭載のローカルファイル管理システムとして、ファイル管理機能を充実させつつ、AI検索・エージェントという独自の強みを活かす。

---

## 1. バージョン管理

### 概要
ファイルの変更履歴を保持し、過去のバージョンに戻せる機能。

### 要件
- ファイル上書きアップロード時に旧バージョンを自動保存
- テキスト編集（OverType）保存時にもバージョン作成
- バージョン一覧表示（日時、変更者、サイズ）
- 任意のバージョンをプレビュー・ダウンロード・復元
- テキストファイルは差分（diff）表示
- バージョン数の上限設定（ストレージ節約）
- 自動パージ（N日以上前のバージョンを削除）

### データモデル

```sql
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    content TEXT,                    -- テキスト内容のスナップショット
    storage_path VARCHAR(1000),      -- 実ファイルのパス（バイナリ）
    file_size BIGINT,
    created_by_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    change_summary VARCHAR(500),     -- 変更概要（自動生成 or ユーザー入力）
    UNIQUE(document_id, version_number)
);
```

### UI
- ドキュメント詳細モーダルに「履歴」タブ追加
- タイムライン形式でバージョン一覧
- 2つのバージョンを選択して差分表示

---

## 2. 共有リンク

### 概要
外部ユーザー（アカウントなし）にファイルを一時的に共有できるURL。

### 要件
- ドキュメント/フォルダ単位で共有リンク生成
- 有効期限設定（1時間〜無期限）
- パスワード保護（オプション）
- ダウンロード回数制限（オプション）
- 権限レベル（閲覧のみ / ダウンロード可）
- 共有リンク一覧管理（管理画面から無効化可能）
- アクセスログ記録

### データモデル

```sql
CREATE TABLE share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,    -- URLに含めるランダムトークン
    password_hash VARCHAR(255),           -- オプション
    permission VARCHAR(20) DEFAULT 'view', -- 'view' | 'download'
    max_downloads INTEGER,                -- NULL = 無制限
    download_count INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ,               -- NULL = 無期限
    created_by_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    is_active BOOLEAN DEFAULT TRUE,
    CHECK (document_id IS NOT NULL OR folder_id IS NOT NULL)
);

CREATE TABLE share_link_access_log (
    id BIGSERIAL PRIMARY KEY,
    share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    ip_address VARCHAR(45),
    user_agent TEXT,
    accessed_at TIMESTAMPTZ DEFAULT now()
);
```

### エンドポイント
- `POST /api/share` — 共有リンク作成
- `GET /api/share/{token}` — 共有コンテンツ取得（認証不要）
- `GET /api/share/{token}/download` — ファイルダウンロード（認証不要）
- `GET /api/share/list` — 自分の共有リンク一覧
- `DELETE /api/share/{id}` — 共有リンク無効化

### UI
- 右クリックメニューに「共有リンク作成」追加
- ダイアログで期限・パスワード・権限設定
- 生成されたURLをワンクリックコピー
- 共有ページは独立したシンプルなレイアウト（ログイン不要）

---

## 3. ストレージクォータ

### 概要
ユーザー/グループ別のストレージ使用量を制限・管理する機能。

### 要件
- ユーザー別クォータ設定（管理画面から）
- グループ別クォータ設定
- 使用量のリアルタイム計算
- クォータ超過時のアップロード拒否
- 使用量ダッシュボード（ユーザー別、ファイルタイプ別）
- 警告通知（80%, 90%, 100%到達時）

### データモデル

```sql
-- ユーザーのクォータ上限はusersテーブルに追加
ALTER TABLE users ADD COLUMN storage_quota_mb INTEGER DEFAULT NULL; -- NULL = 無制限

-- グループのクォータ
ALTER TABLE groups ADD COLUMN storage_quota_mb INTEGER DEFAULT NULL;

-- 使用量は File テーブルの file_size を集計して計算（リアルタイム）
-- キャッシュが必要な場合:
CREATE TABLE storage_usage_cache (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    total_bytes BIGINT DEFAULT 0,
    file_count INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

### UI
- 管理画面にストレージダッシュボード追加
  - 全体使用量（円グラフ）
  - ユーザー別使用量ランキング
  - ファイルタイプ別内訳
- ユーザー設定画面に自分の使用量表示
- サイドバーにストレージバー表示（オプション）

---

## 4. 監査ログ

### 概要
誰がいつ何をしたかを全て記録し、セキュリティ監査・トラブルシューティングに使用。

### 要件
- 全操作をログ記録:
  - ファイル操作: アップロード、ダウンロード、編集、削除、復元、移動
  - フォルダ操作: 作成、リネーム、削除、権限変更
  - ユーザー操作: ログイン、ログアウト、ログイン失敗
  - 管理操作: ユーザー作成/削除、設定変更、グループ操作
  - 共有操作: リンク作成、アクセス
  - AI操作: 検索クエリ、チャット質問
- フィルタリング（ユーザー、操作種別、日時範囲、対象ドキュメント）
- CSV/JSONエクスポート
- ログ保持期間設定（自動パージ）
- 改ざん防止（ログの削除・編集不可、管理者でも）

### データモデル

```sql
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    username VARCHAR(150),           -- ユーザー削除後も残す
    action VARCHAR(50) NOT NULL,     -- 'upload', 'download', 'delete', 'login', etc.
    resource_type VARCHAR(30),       -- 'document', 'folder', 'user', 'setting', etc.
    resource_id VARCHAR(100),        -- 対象のID
    resource_name VARCHAR(500),      -- 対象の名前（削除後も残す）
    details JSONB,                   -- 追加情報（変更前後の値、IPアドレス等）
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX ix_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX ix_audit_logs_action ON audit_logs (action);
CREATE INDEX ix_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX ix_audit_logs_resource ON audit_logs (resource_type, resource_id);
```

### 実装方針
- FastAPI ミドルウェアで自動記録（リクエスト/レスポンスをフック）
- または各エンドポイントで明示的に `audit_log()` ヘルパーを呼ぶ
- ログテーブルは DELETE 権限なし（DB レベルで REVOKE DELETE）

### UI
- 管理画面に「監査ログ」タブ追加
- テーブル表示（無限スクロール）
- フィルタ: ユーザー、操作種別、日時範囲
- ドキュメント詳細モーダルに「アクティビティ」タブ（そのファイルに関するログのみ）

---

## 5. S3 / 外部ストレージ連携

### 概要
ローカルディスク以外のストレージバックエンドをサポート。

### 要件
- ストレージバックエンド:
  - ローカルファイルシステム（現行）
  - Amazon S3 / S3互換（MinIO, Wasabi, Cloudflare R2）
  - WebDAV
- 管理画面からストレージ設定を切り替え
- ファイル単位ではなくシステム全体で1つのバックエンド
- マイグレーションツール（ローカル → S3 等）
- バックエンド抽象化レイヤー

### 実装方針

ストレージ操作を抽象化するインターフェースを定義:

```python
class StorageBackend(ABC):
    @abstractmethod
    async def save(self, path: str, data: bytes) -> str:
        """ファイルを保存し、ストレージパスを返す."""

    @abstractmethod
    async def read(self, path: str) -> bytes:
        """ファイルを読み込む."""

    @abstractmethod
    async def delete(self, path: str) -> None:
        """ファイルを削除する."""

    @abstractmethod
    async def exists(self, path: str) -> bool:
        """ファイルの存在確認."""

    @abstractmethod
    def get_url(self, path: str, expires: int = 3600) -> str:
        """一時的なダウンロードURLを生成（S3 presigned URL等）."""


class LocalStorageBackend(StorageBackend):
    """現行のローカルファイルシステム."""

class S3StorageBackend(StorageBackend):
    """S3互換ストレージ. boto3 使用."""

class WebDAVStorageBackend(StorageBackend):
    """WebDAVサーバー."""
```

### 設定

```
# SystemSetting
storage_backend: "local" | "s3" | "webdav"
s3_endpoint: "https://s3.amazonaws.com"
s3_bucket: "las-files"
s3_access_key: "..."
s3_secret_key: "..."
s3_region: "ap-northeast-1"
webdav_url: "https://..."
webdav_username: "..."
webdav_password: "..."
```

### tusd との統合

tusd は S3 バックエンドをネイティブサポート:

```yaml
tusd:
  command:
    - -s3-bucket=las-files
    - -s3-endpoint=https://s3.amazonaws.com
```

ローカルストレージと S3 で tusd の設定を切り替える。

---

## 6. AI フォルダ自動整理

### 概要
AIがファイルの内容を分析し、最適なフォルダへの仕分けをリコメンド・自動実行する機能。

### 機能パターン

#### A. 未整理ファイルのリコメンド
サイドバーの「未整理」にあるファイルに対して、既存フォルダからベストマッチを提案。

- 未整理ファイル一覧に「AIで整理」ボタン表示
- クリックすると各ファイルに「→ ○○フォルダ」のリコメンドバッジ表示
- 個別に承認/却下、または一括承認で移動

#### B. アップロード時の自動提案
新規アップロード時に、既存フォルダからベストマッチを提案してフォルダ選択を補助。

- アップロード完了後（テキスト抽出後）にバックグラウンドで推定
- トーストまたは通知で「○○フォルダに整理しますか？」
- 承認するとワンクリックで移動

#### C. 一括自動整理
未整理ファイルを全てまとめてAIが分類し、フォルダ振り分けプランを提示。

- 管理画面 or サイドバーから「一括整理」実行
- プレビュー画面で振り分け結果を確認（ファイル名 → 移動先フォルダ）
- 必要に応じて手動修正してから一括実行
- 既存フォルダに該当しないファイルは新規フォルダ作成を提案

### 実装方式

#### 方式1: ベクトル類似度ベース（高速・低コスト）

```python
async def recommend_folder(doc: Document, db: AsyncSession) -> list[dict]:
    """ドキュメントの embedding と各フォルダ内ドキュメントの embedding を比較."""

    # 対象ドキュメントの embedding を取得（先頭チャンク）
    doc_chunk = await db.execute(
        select(Chunk.embedding)
        .where(Chunk.document_id == doc.id)
        .order_by(Chunk.chunk_index)
        .limit(1)
    )
    doc_embedding = doc_chunk.scalar_one_or_none()
    if doc_embedding is None:
        return []

    # 各フォルダの代表ベクトル（フォルダ内ドキュメントの先頭チャンクの平均）
    folders = await db.execute(select(Folder))
    results = []
    for folder in folders.scalars().all():
        folder_chunks = await db.execute(
            select(Chunk.embedding)
            .join(Document, Chunk.document_id == Document.id)
            .where(Document.folder_id == folder.id)
            .where(Chunk.chunk_index == 0)
            .where(Chunk.embedding.is_not(None))
            .limit(10)
        )
        embeddings = [row[0] for row in folder_chunks.all()]
        if not embeddings:
            continue
        # 平均ベクトルとの cosine similarity
        avg = mean_vector(embeddings)
        similarity = cosine_similarity(doc_embedding, avg)
        results.append({"folder_id": str(folder.id), "folder_name": folder.name, "score": similarity})

    return sorted(results, key=lambda x: x["score"], reverse=True)[:3]
```

#### 方式2: LLM ベース（高精度・高コスト）

```python
async def recommend_folder_llm(doc: Document, folders: list[Folder]) -> list[dict]:
    """LLM にフォルダ一覧とファイル要約を渡して最適なフォルダを判断."""

    folder_descriptions = "\n".join(
        f"- {f.name} (ID: {f.id})" for f in folders
    )
    prompt = f"""以下のフォルダ一覧から、このドキュメントに最適なフォルダを最大3つ選んでください。
JSON配列で回答: [{{"folder_id": "...", "reason": "..."}}]

フォルダ一覧:
{folder_descriptions}

ドキュメント:
タイトル: {doc.title}
要約: {doc.summary or "(なし)"}
内容（先頭500文字）: {doc.content[:500]}
"""
    response = await chat_completion([{"role": "user", "content": prompt}])
    # JSON パース...
```

#### 推奨: ハイブリッド方式

1. まずベクトル類似度で候補を5件に絞る（高速）
2. LLM に候補5件 + ファイル情報を渡して最終判断（高精度）

コスト・速度のバランスが良い。

### エンドポイント

```
POST /api/documents/{id}/recommend-folder     — 1ファイルのリコメンド
POST /api/documents/recommend-folders         — 複数ファイルの一括リコメンド
  body: { ids: string[] }
  response: { recommendations: [{ document_id, suggestions: [{ folder_id, folder_name, score, reason }] }] }
POST /api/documents/apply-recommendations     — リコメンド結果を一括適用
  body: { moves: [{ document_id, folder_id }] }
```

### UI

#### サイドバー「未整理」の拡張
```
未整理 (23)  [✨ AIで整理]
```
ボタンクリック → リコメンド取得 → プレビューダイアログ:

```
┌─────────────────────────────────────┐
│ AI フォルダ整理                      │
├─────────────────────────────────────┤
│ 📄 議事録_2024Q3.md   → 📁 議事録    │  [✓] [✕]
│ 📄 見積書_A社.pdf     → 📁 営業資料  │  [✓] [✕]
│ 📄 設計メモ.md        → 📁 開発      │  [✓] [✕]
│ 📄 写真001.jpg        → (該当なし)    │  [—]
├─────────────────────────────────────┤
│           [一括適用] [キャンセル]     │
└─────────────────────────────────────┘
```

---

## 実装優先順位

| 優先度 | 機能 | 理由 |
|--------|------|------|
| 1 | 監査ログ | セキュリティの基盤。他の機能にも必要 |
| 2 | 共有リンク | ユーザーからの要望が多い典型的機能 |
| 3 | AI フォルダ自動整理 | AI差別化の目玉機能。既存インフラで実現可能 |
| 4 | バージョン管理 | データ保護。誤編集からの復旧 |
| 5 | ストレージクォータ | マルチユーザー運用で必要 |
| 6 | S3連携 | 大規模運用・クラウド移行時に必要 |

---

## 現在の実装済み機能

| 機能 | 状態 |
|------|------|
| AI エージェント検索 | ✓ ツール呼び出しで自律的に文書を探索・回答 |
| ベクトル検索 | ✓ 意味的な類似検索 |
| 全文検索 + RRF統合 | ✓ 全文+ベクトルのハイブリッド |
| OCR テキスト抽出 | ✓ 組み込み |
| ドキュメント自動要約 | ✓ LLMで自動生成 |
| テキスト編集（WYSIWYG） | ✓ OverType エディタ |
| API キーによる外部連携 | ✓ フォルダスコープ付き |
| tus レジューマブルアップロード | ✓ |
| ClamAV ウイルススキャン | ✓ |
| 外部共有リンク (Share Server) | ✓ |
| 共有・ダウンロード制御 | ✓ ユーザー/ファイル単位 |
| AI フォルダ自動整理 | 実装予定 |
