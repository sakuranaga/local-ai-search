# 共有リンク機能 設計書

## 概要

LAS 本体は LAN 内のクローズド環境で動作する。外部ユーザーへのファイル共有は、
インターネット上の独立した **LAS Share Server** を経由して行う。

共有リンク作成時に LAS 本体からファイルとメタデータを Share Server に転送し、
外部ユーザーは Share Server からダウンロードする。LAS 本体を外部公開する必要はない。

## アーキテクチャ

```
LAN 内（クローズド）                     インターネット（公開）
┌─────────────────┐   HTTP POST      ┌──────────────────────┐
│   LAS 本体      │ ──────────────→ │  LAS Share Server     │
│  (ファイル管理)  │   ファイル+       │  Go + SQLite (WAL)    │
│  クローズド環境  │   メタデータ転送  │  Docker               │
└─────────────────┘                  │  https://share.example│
                                     └──────────┬───────────┘
                                                ↑
                                          外部ユーザー
                                          トークンでアクセス
                                          認証不要
```

## LAS Share Server

### 技術スタック

| 項目 | 技術 |
|------|------|
| 言語 | Go |
| DB | SQLite + WAL モード |
| HTTP | net/http + chi router |
| Docker | alpine ベース（イメージ ~15MB） |
| TLS | リバースプロキシ（Caddy / nginx）に委任 |

### プロジェクト構造

```
las-share-server/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── go.mod
├── go.sum
├── main.go              # エントリポイント + HTTP サーバー
├── handler.go           # リクエストハンドラー
├── store.go             # SQLite データアクセス
├── auth.go              # パスワード検証 + 一時トークン
├── cleanup.go           # 期限切れファイル自動削除
├── cli.go               # CLI コマンド（APIキー管理等）
├── templates/
│   ├── download.html    # ダウンロードページ
│   ├── password.html    # パスワード入力ページ
│   └── error.html       # エラーページ
└── data/
    ├── share.db          # SQLite データベース
    └── files/            # 共有ファイル保存先
```

### データモデル (SQLite)

```sql
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,      -- SHA-256 ハッシュ
    name TEXT NOT NULL,                 -- "本社LAS" 等の識別名
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
);

CREATE TABLE share_links (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    password_hash TEXT,                 -- SHA-256 + salt（NULL = パスワードなし）
    expires_at DATETIME NOT NULL,       -- 必須（最大30日）
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    api_key_id TEXT REFERENCES api_keys(id)
);

CREATE TABLE access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
    action TEXT NOT NULL,               -- 'download' | 'password_fail'
    ip_address TEXT,
    user_agent TEXT,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### CLI コマンド

```bash
# APIキー管理
share-server key create --name "本社LAS"
# => Created API key: sk_xxxxxxxxxxxxxxxx
# => (この値をLAS本体の管理画面に設定)

share-server key list
# ID          Name       Created     Active
# abc123..    本社LAS    2026-03-15  ✓

share-server key revoke <id>

# リンク管理
share-server links
# Token        Filename       Expires      Downloads
# aB3xK...    設計書.pdf     2026-03-22   5

share-server links delete <token>

# ステータス
share-server status
# Links:    42 active, 8 expired
# Storage:  2.3 GB used
# API Keys: 2 active
```

### API エンドポイント

#### 内部 API（LAS 本体 → Share Server、APIキー認証）

##### `POST /api/internal/upload`

```
Headers:
  X-Api-Key: sk_xxxxxxxxxxxxxxxx

Body (multipart/form-data):
  file: <binary>
  token: "random-token"
  filename: "設計書.pdf"
  file_type: "pdf"
  password_hash: "salt$hash"          (空文字 = パスワードなし)
  expires_at: "2026-03-22T00:00:00Z"
  created_by: "shuzan"

Response: 201
  {
    "url": "https://share.example/s/random-token"
  }
```

##### `DELETE /api/internal/{token}`

```
Headers:
  X-Api-Key: sk_xxxxxxxxxxxxxxxx

Response: 204
```

##### `GET /api/internal/status`

```
Headers:
  X-Api-Key: sk_xxxxxxxxxxxxxxxx

Response: 200
  {
    "active_links": 42,
    "storage_used_bytes": 2400000000,
    "ok": true
  }
```

#### 公開エンドポイント（外部ユーザー、認証不要）

##### `GET /s/{token}`

HTML ページを返す。Go テンプレートで生成。
- パスワードなし → ダウンロードページ
- パスワードあり → パスワード入力ページ
- 期限切れ / 無効 → エラーページ

##### `POST /s/{token}/verify`

```
Form data: password=xxx

Success: Set-Cookie で一時トークン設定 + ダウンロードページにリダイレクト
Failure: パスワード入力ページに戻る（エラーメッセージ付き）
```

Cookie ベースの認証（ブラウザのフォーム送信で完結、JavaScript 不要）。

##### `GET /s/{token}/download`

```
パスワード保護の場合: Cookie の一時トークンを検証

Response: 200
  Content-Disposition: attachment; filename="設計書.pdf"
  <binary>

Errors:
  404: 共有リンクが見つかりません
  410: 有効期限切れ
  401: パスワード認証が必要です
```

### 共有ページ（HTML テンプレート）

JavaScript 不要。Go のテンプレートで直接 HTML を生成。

#### ダウンロードページ

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>{{.Filename}} - LAS Share</title></head>
<body style="display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif">
  <div style="text-align:center;max-width:400px">
    <h2>📄 {{.Filename}}</h2>
    <p>共有者: {{.CreatedBy}}</p>
    <p>有効期限: {{.ExpiresAt}}</p>
    <p>サイズ: {{.FileSize}}</p>
    <a href="/s/{{.Token}}/download" style="display:inline-block;padding:12px 24px;background:#333;color:#fff;border-radius:6px;text-decoration:none">
      ダウンロード
    </a>
    <p style="margin-top:48px;color:#888;font-size:12px">Powered by LAS</p>
  </div>
</body>
</html>
```

#### パスワード入力ページ

```html
<form method="POST" action="/s/{{.Token}}/verify">
  <h2>🔒 パスワードで保護されています</h2>
  {{if .Error}}<p style="color:red">{{.Error}}</p>{{end}}
  <input type="password" name="password" placeholder="パスワード" required>
  <button type="submit">開く</button>
</form>
```

### 設定（環境変数）

```env
SHARE_PORT=8080
SHARE_DATA_DIR=/data
SHARE_BASE_URL=https://share.example
SHARE_JWT_SECRET=changeme
SHARE_MAX_FILE_SIZE_MB=500
SHARE_CLEANUP_INTERVAL_HOURS=1
```

### 期限切れファイル自動削除

goroutine が定期的に実行（デフォルト1時間ごと）：

```go
func cleanupLoop(db *sql.DB, dataDir string, interval time.Duration) {
    for {
        time.Sleep(interval)
        rows, _ := db.Query(`
            SELECT id, file_path FROM share_links
            WHERE expires_at < datetime('now') OR is_active = 0
        `)
        for rows.Next() {
            var id, path string
            rows.Scan(&id, &path)
            os.Remove(filepath.Join(dataDir, "files", path))
            db.Exec("DELETE FROM access_log WHERE share_link_id = ?", id)
            db.Exec("DELETE FROM share_links WHERE id = ?", id)
        }
        rows.Close()
    }
}
```

## LAS 本体側の変更

### 管理画面設定

| 設定キー | デフォルト | 説明 |
|---------|----------|------|
| `share_server_url` | (空) | Share Server の内部 API URL |
| `share_server_api_key` | (空) | Share Server の API キー |
| `share_enabled` | `false` | 共有機能の有効/無効 |

`share_base_url` は不要（Share Server が URL を返す）。

### 共有リンク作成フロー

```
1. ユーザーが右クリック → 共有リンク作成
2. ダイアログ表示（期限、パスワード設定）
3. LAS 本体が share_links テーブルにレコード作成
4. LAS 本体がファイル + メタデータを Share Server に HTTP POST
5. Share Server がファイル保存 + URL を返す
6. LAS 本体がユーザーに URL を表示
```

### 共有リンク作成ダイアログ

```
┌─────────────────────────────────────────┐
│ 共有リンクを作成                          │
├─────────────────────────────────────────┤
│ ファイル: 設計書.pdf                      │
│                                         │
│ 有効期限:  [7日間 ▼]                     │
│   (1時間 / 1日 / 7日 / 30日)             │
│                                         │
│ □ パスワード保護                          │
│   パスワード: [________]                  │
│                                         │
├─────────────────────────────────────────┤
│ [キャンセル]              [リンクを作成]  │
└─────────────────────────────────────────┘
```

### LAS 本体の share_links テーブル

Share Server に転送した記録を保持（一覧表示・無効化用）。

```sql
-- LAS 本体のDBに保持
CREATE TABLE share_links (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    token VARCHAR(64) NOT NULL,
    has_password BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    share_url TEXT NOT NULL,            -- Share Server から返された URL
    created_by_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    is_active BOOLEAN DEFAULT TRUE
);
```

## セキュリティ考慮事項

- **LAS 本体は外部公開しない** — ファイル転送は LAS → Share Server の一方向のみ
- **APIキー認証** — Share Server の内部 API は APIキーで保護
- **パスワード** — SHA-256 + salt でハッシュ化。LAS 本体でハッシュ化してから転送（平文は Share Server にも渡さない）
- **有効期限必須** — 最大30日。期限切れファイルは自動削除
- **Cookie ベース認証** — パスワード認証後の一時トークンは HttpOnly Cookie（XSS 対策）
- **レートリミット** — パスワード認証は IP 単位で制限
- **ファイル削除の確実性** — goroutine による定期削除 + CLI での手動削除

## 実装手順

### Phase 1: Share Server（Go）— 独立リポジトリ
1. プロジェクト初期化（go mod, Dockerfile, docker-compose）
2. SQLite + WAL セットアップ
3. CLI（APIキー管理、リンク一覧、ステータス）
4. 内部 API（upload, delete, status）
5. 公開ページ（HTML テンプレート、パスワード認証、ダウンロード）
6. 期限切れファイル自動削除 goroutine

### Phase 2: LAS 本体修正
1. 管理画面設定追加（share_server_url, share_server_api_key）
2. share ルーター修正（ファイル転送ロジック）
3. 共有リンク作成ダイアログ修正（回数制限・権限削除済み）
4. 共有リンク削除時の Share Server 連携
