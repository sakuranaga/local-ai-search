# 共有リンク機能 設計書

## 概要

外部ユーザー（アカウントなし）にファイルを一時的に共有できるURL機能。
現在 Cloudflare Tunnel (cloudflared) で認証しているため、共有リンクは**別ドメイン**で認証なしアクセスできる必要がある。

## ドメイン構成

```
las.ddr8.com           ← メインアプリ（cloudflared 認証あり）
las-share.ddr8.com     ← 共有リンク専用（認証なし、公開）
```

共有リンクのベースURLは管理画面の SystemSetting で設定可能にする。

| 設定キー | デフォルト値 | 説明 |
|---------|------------|------|
| `share_base_url` | `http://localhost:3002/s` | 共有リンクのベースURL |

例: `share_base_url = https://las-share.ddr8.com/s`
生成されるURL: `https://las-share.ddr8.com/s/{token}`

## アーキテクチャ

```
外部ユーザー (認証なし)
  ↓ https://las-share.ddr8.com/s/{token}
cloudflared (認証バイパス: las-share.ddr8.com は認証なし設定)
  ↓
nginx
  ↓ /s/{token} → React SPA (SharePage)
  ↓ /api/share/{token} → FastAPI backend (認証不要エンドポイント)
backend
  ↓ トークン検証 → ファイル配信
```

### cloudflared の設定

`las-share.ddr8.com` は Cloudflare Access のバイパス設定にするか、
別のトンネル設定で認証なしにする。

```yaml
# cloudflared config
ingress:
  - hostname: las.ddr8.com
    service: http://nginx:80
    # Cloudflare Access で認証あり

  - hostname: las-share.ddr8.com
    service: http://nginx:80
    # 認証なし（Access ポリシーでバイパス）
```

### nginx の設定

共有リンク専用の location を追加。`/s/` パスと `/api/share/` パスを処理。

```nginx
# 共有リンクページ (React SPA)
location /s/ {
    try_files $uri /index.html;
}
```

API 側の `/api/share/` は既存の `/api/` location でカバーされるため追加不要。

## 要件

- ドキュメント単位で共有リンク生成（フォルダ共有は将来対応）
- 有効期限設定（1時間 / 1日 / 7日 / 30日 / 無期限）
- パスワード保護（オプション）
- ダウンロード回数制限（オプション）
- 権限レベル（閲覧のみ / ダウンロード可）
- 共有リンク一覧管理（作成者が自分のリンクを管理、管理者は全て管理）
- アクセスログ記録
- 共有中のファイルがファイル一覧で視覚的にわかる

## データモデル

### share_links テーブル

```sql
CREATE TABLE share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    token VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    permission VARCHAR(20) DEFAULT 'view' NOT NULL,  -- 'view' | 'download'
    max_downloads INTEGER,                           -- NULL = 無制限
    download_count INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ,                          -- NULL = 無期限
    created_by_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX ix_share_links_token ON share_links (token);
CREATE INDEX ix_share_links_document_id ON share_links (document_id);
```

### share_link_access_log テーブル

```sql
CREATE TABLE share_link_access_log (
    id BIGSERIAL PRIMARY KEY,
    share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL,  -- 'view' | 'download' | 'password_fail'
    ip_address VARCHAR(45),
    user_agent TEXT,
    accessed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ix_share_access_log_link_id ON share_link_access_log (share_link_id);
```

### SQLAlchemy モデル

```python
class ShareLink(Base):
    __tablename__ = "share_links"

    id = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    token = mapped_column(String(64), unique=True, nullable=False)
    password_hash = mapped_column(String(255), nullable=True)
    permission = mapped_column(String(20), nullable=False, default="view")
    max_downloads = mapped_column(Integer, nullable=True)
    download_count = mapped_column(Integer, default=0)
    expires_at = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_id = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    is_active = mapped_column(Boolean, default=True)

    document = relationship("Document")
    created_by = relationship("User")


class ShareLinkAccessLog(Base):
    __tablename__ = "share_link_access_log"

    id = mapped_column(Integer, primary_key=True, autoincrement=True)
    share_link_id = mapped_column(UUID(as_uuid=True), ForeignKey("share_links.id", ondelete="CASCADE"), nullable=False)
    action = mapped_column(String(20), nullable=False)
    ip_address = mapped_column(String(45), nullable=True)
    user_agent = mapped_column(Text, nullable=True)
    accessed_at = mapped_column(DateTime(timezone=True), server_default=func.now())
```

## バックエンド API

### 認証が必要なエンドポイント（メインアプリ用）

#### `POST /api/share` — 共有リンク作成

```python
class ShareLinkCreate(BaseModel):
    document_id: str
    permission: str = "view"           # "view" | "download"
    password: str | None = None        # 設定するとハッシュ化して保存
    max_downloads: int | None = None   # NULL = 無制限
    expires_in: str | None = None      # "1h" | "1d" | "7d" | "30d" | None(無期限)

class ShareLinkResponse(BaseModel):
    id: str
    document_id: str
    document_title: str
    token: str
    url: str                           # share_base_url + /s/ + token
    permission: str
    has_password: bool
    max_downloads: int | None
    download_count: int
    expires_at: datetime | None
    created_by_name: str
    created_at: datetime
    is_active: bool
```

処理:
1. ドキュメントの所有権・書き込み権限チェック
2. トークン生成（`secrets.token_urlsafe(32)`）
3. パスワードがあれば bcrypt ハッシュ化
4. `expires_in` → `expires_at` 変換
5. `share_base_url` 設定を読んで完全URLを返す

#### `GET /api/share/list` — 共有リンク一覧

- 一般ユーザー: 自分が作成したリンクのみ
- 管理者: 全リンク
- レスポンスにアクセス数（access_log の COUNT）を含む

#### `DELETE /api/share/{id}` — 共有リンク無効化

- 作成者 or 管理者のみ
- `is_active = False` に設定（論理削除）

#### `PATCH /api/share/{id}` — 共有リンク更新

- 期限延長、パスワード変更、権限変更、ダウンロード上限変更

### 認証不要エンドポイント（共有ページ用）

#### `GET /api/share/{token}` — 共有コンテンツ情報取得

```python
class SharePublicResponse(BaseModel):
    document_title: str
    file_type: str
    file_size: int | None
    permission: str           # "view" | "download"
    requires_password: bool
    has_preview: bool         # プレビュー可能か
    created_by_name: str
    expires_at: datetime | None
```

処理:
1. トークンで ShareLink を検索
2. `is_active` チェック
3. 有効期限チェック
4. ダウンロード回数チェック
5. パスワード保護の場合: `requires_password: true` を返す（内容は未表示）
6. アクセスログ記録

#### `POST /api/share/{token}/verify` — パスワード認証

```python
class SharePasswordVerify(BaseModel):
    password: str

# 成功時: 一時トークン（JWT, 30分有効）を返す
# 失敗時: 401
```

パスワード認証成功後、一時トークンをクエリパラメータまたはヘッダーで後続リクエストに付与。

#### `GET /api/share/{token}/preview` — ファイルプレビュー

- パスワード保護の場合、一時トークン必須
- テキスト: content を返す
- PDF: inline 配信
- 画像: inline 配信
- その他: プレビュー不可

#### `GET /api/share/{token}/download` — ファイルダウンロード

- `permission == "download"` のチェック
- パスワード保護の場合、一時トークン必須
- `download_count` をインクリメント
- `max_downloads` 超過チェック
- アクセスログ記録（action: "download"）

## フロントエンド

### メインアプリ側

#### コンテキストメニュー追加

ドキュメント右クリックメニューに「共有リンク作成」を追加。

#### 共有リンク作成ダイアログ

```
┌─────────────────────────────────────────┐
│ 共有リンクを作成                          │
├─────────────────────────────────────────┤
│ ファイル: 設計書.pdf                      │
│                                         │
│ 権限:  ○ 閲覧のみ  ● ダウンロード可      │
│                                         │
│ 有効期限:  [7日間 ▼]                     │
│                                         │
│ □ パスワード保護                          │
│   パスワード: [________]                  │
│                                         │
│ □ ダウンロード回数制限                    │
│   最大回数:   [10]                        │
│                                         │
├─────────────────────────────────────────┤
│ [キャンセル]              [リンクを作成]  │
└─────────────────────────────────────────┘
```

作成後:

```
┌─────────────────────────────────────────┐
│ 共有リンクを作成しました                  │
├─────────────────────────────────────────┤
│                                         │
│ https://las-share.ddr8.com/s/aB3x...    │
│                                [コピー]  │
│                                         │
│ 有効期限: 2026-03-22 14:00              │
│ 権限: ダウンロード可                     │
│ パスワード: あり                          │
│                                         │
├─────────────────────────────────────────┤
│                              [閉じる]    │
└─────────────────────────────────────────┘
```

#### 共有中ファイルの視覚的表示

ファイル一覧のテーブルで、アクティブな共有リンクがあるドキュメントを視覚的に区別:

- ファイル名の横に共有アイコン（🔗 / LinkIcon）を表示
- アイコンをホバーすると「共有中（N件のリンク）」のツールチップ

実装:
- `DocumentListItem` に `share_count: int` フィールドを追加
- list_documents クエリで share_links テーブルを LEFT JOIN + COUNT

```python
# list_documents クエリに追加
share_count_sq = (
    select(
        ShareLink.document_id,
        func.count(ShareLink.id).label("share_count"),
    )
    .where(ShareLink.is_active.is_(True))
    .group_by(ShareLink.document_id)
    .subquery()
)
# base query に outerjoin
.outerjoin(share_count_sq, Document.id == share_count_sq.c.document_id)
# select に追加
func.coalesce(share_count_sq.c.share_count, 0).label("share_count"),
```

#### 共有リンク管理ダイアログ

ドキュメント詳細モーダルに「共有」タブを追加。
そのドキュメントの共有リンク一覧を表示:

```
┌──────────────────────────────────────────────┐
│ 共有リンク                                    │
├──────────────────────────────────────────────┤
│ 🔗 aB3xK...  ダウンロード可  期限: 3/22      │
│   アクセス: 5回  DL: 2/10     [コピー] [削除] │
│                                              │
│ 🔗 Ym8pQ...  閲覧のみ       期限: なし        │
│   アクセス: 12回  🔒パスワード [コピー] [削除] │
│                                              │
│                          [＋ 新しいリンク]     │
└──────────────────────────────────────────────┘
```

### 共有ページ（別ドメイン / 認証不要）

`/s/{token}` にアクセスした時の専用ページ。
メインアプリとは別のシンプルなレイアウト。

#### パスワードなしの場合

```
┌──────────────────────────────────────────┐
│                                          │
│  📄 設計書.pdf                            │
│  共有者: shuzan                          │
│  有効期限: 2026-03-22                    │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │                                  │    │
│  │      (ファイルプレビュー)          │    │
│  │                                  │    │
│  └──────────────────────────────────┘    │
│                                          │
│           [ダウンロード]                  │
│                                          │
│  Powered by LAS                          │
└──────────────────────────────────────────┘
```

#### パスワードありの場合（認証前）

```
┌──────────────────────────────────────────┐
│                                          │
│  🔒 この共有リンクはパスワードで          │
│     保護されています                      │
│                                          │
│  パスワード: [____________]  [開く]       │
│                                          │
│  Powered by LAS                          │
└──────────────────────────────────────────┘
```

#### エラー表示

```
リンクの有効期限が切れています
リンクが無効です
ダウンロード回数の上限に達しました
```

### React ルーティング

```typescript
// App.tsx
<Routes>
  {/* メインアプリ */}
  <Route path="/login" element={<LoginPage />} />
  <Route path="/admin" element={<AdminPage />} />
  <Route path="/" element={<FileExplorerPage />} />

  {/* 共有ページ（認証不要） */}
  <Route path="/s/:token" element={<SharePage />} />
</Routes>
```

`SharePage` は `LoginPage` のように認証チェックをスキップ。

## 管理画面

### SystemSetting 追加

| 設定キー | デフォルト値 | 説明 |
|---------|------------|------|
| `share_base_url` | (空) | 共有リンクのベースURL。空の場合は現在のドメインを使用 |
| `share_enabled` | `true` | 共有機能の有効/無効 |
| `share_max_expiry_days` | `90` | 有効期限の最大日数（0 = 無期限許可） |

### 管理画面に共有リンク管理タブ追加

全ユーザーの共有リンク一覧を管理者が閲覧・無効化可能。

## 実装手順

### Phase 1: バックエンド基盤
1. ShareLink, ShareLinkAccessLog モデル追加
2. DB マイグレーション（main.py に ALTER TABLE 追加）
3. `share_base_url`, `share_enabled` を SystemSetting に追加
4. `/api/share` ルーター実装（CRUD + 公開エンドポイント）
5. パスワード認証用の一時トークン発行ロジック

### Phase 2: フロントエンド（メインアプリ）
1. 共有リンク作成ダイアログ
2. コンテキストメニューに「共有リンク作成」追加
3. ドキュメント詳細モーダルに「共有」タブ追加
4. ファイル一覧の共有アイコン表示（share_count）
5. 共有リンク管理（管理画面タブ）

### Phase 3: 共有ページ
1. `SharePage` コンポーネント作成
2. パスワード認証フロー
3. ファイルプレビュー表示
4. ダウンロード機能
5. エラー表示（期限切れ、無効、回数超過）

### Phase 4: インフラ
1. nginx に `/s/` location 追加
2. cloudflared の設定変更（las-share.ddr8.com を認証バイパス）
3. 管理画面で `share_base_url` を設定

## セキュリティ考慮事項

- **トークンの強度**: `secrets.token_urlsafe(32)` で 256bit のランダムトークン
- **レートリミット**: パスワード認証は 5回/分 のレートリミット（ブルートフォース防止）
- **アクセスログ**: 全アクセスを記録、不審なアクセスパターンの検出に使用
- **共有リンクの無効化**: 元のドキュメントが削除されたら CASCADE で自動削除
- **パスワード**: bcrypt でハッシュ化、平文は保存しない
- **一時トークン**: パスワード認証後の JWT は 30分有効、リプレイ攻撃防止
- **ドメイン分離**: メインアプリと共有ページを別ドメインにすることで、共有ページから認証情報にアクセスされるリスクを排除
