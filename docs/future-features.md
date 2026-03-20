# 将来機能ロードマップ

## ビジョン

AI搭載のローカルファイル管理システムとして、ファイル管理機能を充実させつつ、AI検索・エージェントという独自の強みを活かす。

---

## 実装済み機能

以下は設計・実装が完了した機能です。

| 機能 | 状態 | 備考 |
|------|------|------|
| AI エージェント検索 | ✅ | ReAct 方式ツール呼び出し |
| ベクトル検索 + 全文検索 (RRF) | ✅ | pgvector + pg_bigm ハイブリッド |
| OCR テキスト抽出 | ✅ | Surya OCR (GPU対応) |
| ドキュメント自動要約 | ✅ | LLM で自動生成 |
| テキスト編集（WYSIWYG） | ✅ | OverType エディタ |
| API キーによる外部連携 | ✅ | フォルダスコープ + 権限制限付き |
| tus レジューマブルアップロード | ✅ | 中断再開可能、進捗表示 |
| ClamAV ウイルススキャン | ✅ | アップロード時自動スキャン |
| 外部共有リンク (Share Server) | ✅ | Go + SQLite 独立デプロイ、パスワード・期限付き |
| 共有・ダウンロード制御 | ✅ | ユーザー/ファイル単位で禁止フラグ |
| Unix スタイルパーミッション | ✅ | owner / group / others の read / write 制御 |
| 監査ログ | ✅ | 全操作記録、フィルタ、CSVエクスポート |
| 汎用ファイルアップロード | ✅ | 全ファイルタイプ対応、Tier 1/2/3 分類 |
| LibreOffice プレビュー | ✅ | PPTX/DOCX/DOC/RTF → PDF → PNG 画像プレビュー |
| 動画プレビュー (video.js v10) | ✅ | 全主要ビデオフォーマット対応 |
| 音声プレビュー | ✅ | ブラウザネイティブ `<audio>` |
| ゴミ箱 | ✅ | ソフトデリート + 復元 + 完全削除 |
| メール通知 | ✅ | SMTP/SendGrid/Resend/SES、バッチ集約送信 |
| お気に入り | ✅ | ユーザー別スター登録、サイドバー・右クリック・モーダルから操作 |
| フォルダアップロード | ✅ | ドラッグ&ドロップでフォルダ階層を自動作成、隠しディレクトリ自動除外 |
| アップロードキュー | ✅ | 同時3件制限、バッチ進捗パネル、1000件上限、中止・キャンセル対応 |
| バージョン管理 | ✅ | アップロード時v1自動作成、編集・上書き時に自動バージョン追加、復元、変更種別表示 |

---

## 改善検討事項

### ClamAV 未接続時のアップロード拒否

現在、ClamAV が停止・未接続の場合はウイルススキャンをスキップ（`skipped`）してアップロードが成功する。
拡張子偽装を含む全ファイルを確実にスキャンするため、ClamAV が利用不可の場合にアップロードを拒否するオプション（`require_virus_scan` システム設定）を追加を検討。

- `require_virus_scan = true`: ClamAV 接続不可 → アップロード拒否（安全優先）
- `require_virus_scan = false`: 現行動作（スキップしてアップロード許可）

---

## 未実装機能

---

## 1. ストレージクォータ

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

## 2. S3 / 外部ストレージ連携

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

## 3. AI フォルダ自動整理

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

## 4. SSO / エンタープライズ認証

### 概要
企業の既存 ID 基盤（Active Directory, Azure AD, Okta, Google Workspace 等）と連携し、シングルサインオンを実現する。

### 背景
現在はユーザー名 + パスワードによる独自認証。企業導入時に「既存の ID 基盤と統合したい」という要望が想定される。

### 構成案: Keycloak（IdP ブローカー）

```
顧客企業 A         顧客企業 B
┌──────────┐      ┌──────────┐
│ Azure AD │      │  Okta    │
└────┬─────┘      └────┬─────┘
     │ SAML/OIDC       │ SAML/OIDC
     ▼                  ▼
┌───────────────────────────┐       OIDC        ┌──────────────┐
│        Keycloak           │◄─────────────────►│ FastAPI      │
│  (IdP ブローカー)          │    トークン検証    │ バックエンド   │
│  - Realm per 顧客         │                   └──────┬───────┘
│  - Identity Brokering     │                          │
└───────────────────────────┘                   ┌──────┴───────┐
                                                │ React        │
                                                │ フロントエンド │
                                                └──────────────┘
```

**Keycloak の役割:**
- 各顧客の IdP（Azure AD, Okta, Google Workspace, LDAP 等）を Identity Brokering で統合
- LAS は Keycloak とだけ OIDC で接続すればよい（顧客追加時にコード変更不要）
- 顧客ごとに Realm または Identity Provider を追加するだけで対応完了

### Keycloak vs Authentik

| | Keycloak | Authentik |
|---|---|---|
| 実績 | Red Hat、企業採用多数 | 新しめ、成長中 |
| リソース | 重い（Java、1-2GB RAM） | 軽い（Python/Go、512MB〜） |
| Docker | 公式対応 | Docker-first 設計 |
| AD/LDAP 連携 | 非常に成熟 | 対応している |
| UI | 機能的だが古め | モダンで使いやすい |
| SCIM | プラグイン | 組み込み |

**推奨:** 企業向け提供なら Keycloak（「Keycloak 対応」で IT 部門が安心する）

### バックエンド変更

現在のパスワード認証は**残したまま** OIDC を追加する形で実装可能:

1. `docker-compose.yml` に Keycloak コンテナ追加（PostgreSQL 共有可）
2. FastAPI に OIDC ミドルウェア追加（既存パスワード認証と並行稼働）
3. ログイン画面に「SSO でログイン」ボタン追加
4. JWT からユーザー自動作成（JIT Provisioning）

**想定工数:** バックエンド変更は 100-200 行程度

### 顧客導入フロー

1. 顧客「うちは Azure AD 使ってる」
2. Keycloak 管理画面で Identity Provider 追加（Azure AD のメタデータ URL を入れるだけ）
3. 顧客側はエンタープライズアプリ登録（redirect URI 設定）
4. 完了 — コード変更不要

### エンドポイント（追加分）

```
GET  /api/auth/sso/login     — SSO ログイン開始（Keycloak にリダイレクト）
GET  /api/auth/sso/callback   — OIDC コールバック（トークン受取 → JWT 発行）
GET  /api/auth/sso/config     — SSO 設定状態（有効/無効、プロバイダ名）
```

---

## 実装優先順位

| 優先度 | 機能 | 理由 |
|--------|------|------|
| 1 | AI フォルダ自動整理 | AI差別化の目玉機能。既存インフラで実現可能 |
| 2 | SSO / エンタープライズ認証 | 企業導入時の必須要件になりうる |
| 3 | ストレージクォータ | マルチユーザー運用で必要 |
| 4 | S3連携 | 大規模運用・クラウド移行時に必要 |
