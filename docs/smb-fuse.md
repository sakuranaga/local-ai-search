# SMB ファイル共有機能 (FUSE 仮想 FS アプローチ)

## Context

LAS に Samba コンテナを追加し、FUSE 仮想ファイルシステム経由でファイルを SMB 共有する。FUSE デーモンが DB を参照して LAS のフォルダ構造/ファイル名の仮想ビューを生成し、実際の I/O は既存の UUID ベースストレージに透過的にリダイレクトする。書き込みはステージングディレクトリで受け、バックグラウンドワーカーが DB に同期する。既存のストレージ構造もバックエンドコードも変更不要。

## アーキテクチャ

```
PC (SMB, LAS ユーザー ID/PW)
    |
Samba コンテナ (/share-base = FUSE マウントを rslave で参照)
    |
FUSE デーモン (/mnt/base/fs, rshared でホストに伝播)
    | DB クエリでパス解決 + 実ファイルに I/O リダイレクト
    | 書き込み → ステージング → バックグラウンド同期 → DB + UUID ストレージ
./data/storage/uploads/{uid or smb}/{uuid}_filename  (既存ストレージそのまま)
```

## Docker マウント伝播 (named volume ではなくバインドマウント)

FUSE マウントはバインドマウントのサブディレクトリに行う必要がある。直接マウントでは伝播しない。

```yaml
las-fuse:
  devices:
    - /dev/fuse:/dev/fuse
  cap_add:
    - SYS_ADMIN
  security_opt:
    - apparmor:unconfined                        # FUSE マウントに必要
  volumes:
    - ./data/fuse-mount:/mnt/base:rshared       # ホストに伝播
    - ./data:/data/storage                       # UUID ストレージ
    - ./data/smb-staging:/data/smb-staging       # ステージング領域

samba:
  volumes:
    - ./data/fuse-mount:/share-base:rslave       # ホスト経由で受け取る
    - ./data/smb-sync:/smb-sync                  # パスワード同期
    - samba_data:/var/lib/samba                   # tdbsam 永続化
```

FUSE デーモンは `/mnt/base/fs` にマウントし、Samba は `/share-base/fs` を参照する。

**ホスト側の前提条件** (`scripts/setup-smb.sh` で自動設定):

```bash
sudo mkdir -p ./data/fuse-mount
sudo mount --bind ./data/fuse-mount ./data/fuse-mount
sudo mount --make-shared ./data/fuse-mount
```

`setup-smb.sh` は冪等に動作し、既にマウント済みの場合はスキップする。ホスト再起動で設定が失われるため、永続化には `/etc/fstab` への追記が必要 (スクリプトが案内を表示)。

## セキュリティ

- SMB3 必須 (`server min protocol = SMB3`, `smb encrypt = desired`)
- 認証: tdbsam + LAS ログイン時のパスワード同期 (PAM 不使用)
- ゲストアクセス無効 (`map to guest = never`)
- 書き込み権限チェック: `_can_write_entry()` / `_can_write_folder_sync()` で owner/group/others の書き込み権限を検証
- FUSE コンテナ: 非特権モード (`devices: /dev/fuse` + `cap_add: SYS_ADMIN` + `apparmor:unconfined`)。`privileged: true` は不要
- ポート 445: LAN/VPN 内のみ公開。README にファイアウォール設定を記載
- 内部 API (`/api/auth/smb-users`, `/api/auth/smb-verify`): `X-Internal-Key` ヘッダーで認証、nginx で外部非公開

## Samba コンテナ設計 (自前ビルド)

dperson/samba は最終更新が数年前でセキュリティパッチが適用されない。`alpine:3.21` ベースで自前ビルドする。

### samba/Dockerfile

```dockerfile
FROM alpine:3.21
RUN apk add --no-cache \
    samba \
    samba-common-tools \
    curl \
    jq \
    shadow \
    tini
COPY smb.conf /etc/samba/smb.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 445
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]
```

パッケージの役割:
- `samba`: SMB サーバー本体
- `samba-common-tools`: smbpasswd, pdbedit 等の管理ツール
- `curl` + `jq`: entrypoint から LAS API を呼ぶため
- `shadow`: useradd, groupadd で Unix ユーザーを動的作成
- `tini`: PID 1 のシグナルハンドリング (zombie reaping)

### samba/smb.conf

```ini
[global]
server string = LAS File Server
server min protocol = SMB3
smb encrypt = desired
security = user
map to guest = never
log level = 1
max log size = 1000

passdb backend = tdbsam
obey pam restrictions = no

unix charset = UTF-8
dos charset = CP932

socket options = TCP_NODELAY IPTOS_LOWDELAY
read raw = yes
write raw = yes
use sendfile = yes
aio read size = 16384
aio write size = 16384

# macOS compatibility (no streams_xattr — FUSE doesn't support named streams)
vfs objects = fruit
fruit:metadata = netatalk
fruit:model = MacSamba
fruit:nfs_aces = no
fruit:resource = file
fruit:encoding = native

[LAS]
path = /share-base/fs
browseable = yes
read only = no
admin users = @las_admins
```

設定のポイント:
- `smb encrypt = desired`: LAN 内利用で暗号化非対応クライアントとの互換性を確保
- `dos charset = CP932`: Windows 日本語環境との互換性
- `vfs objects = fruit` (streams_xattr なし): FUSE が named streams をサポートしないため
- `fruit:metadata = netatalk`: streams_xattr の代替。macOS メタデータを `._` ファイルに保存
- `fruit:resource = file`: リソースフォークをファイルベースで管理
- `read only = no`: 書き込み対応 (Phase 2 で変更)
- `samba_data` named volume で tdbsam データを永続化 (コンテナ再起動でパスワードが失われない)

### samba/entrypoint.sh (起動時ユーザー同期 + パスワード同期ループ)

```sh
#!/bin/sh
set -e
export SMB_INTERNAL_KEY

echo "Syncing users from LAS backend..."

# バックエンドが起動するまで待機 (最大 60 秒)
for i in $(seq 1 60); do
  if curl -sf -H "X-Internal-Key: $SMB_INTERNAL_KEY" \
    http://backend:8000/api/auth/smb-users > /dev/null 2>&1; then
    break
  fi
  echo "Waiting for backend... ($i/60)"
  sleep 1
done

USERS_JSON=$(curl -sf -H "X-Internal-Key: $SMB_INTERNAL_KEY" \
  http://backend:8000/api/auth/smb-users 2>/dev/null || echo '{"users":[],"groups":[]}')

# las_admins グループ作成 (admin users = @las_admins 用)
addgroup -g 19999 las_admins 2>/dev/null || true

# グループの同期
echo "$USERS_JSON" | jq -r '.groups[] | "\(.gid) \(.name)"' 2>/dev/null | \
while read -r gid name; do
  if [ -n "$gid" ] && ! getent group "$name" > /dev/null 2>&1; then
    addgroup -g "$gid" "$name" 2>/dev/null || true
  fi
done

# ユーザーの同期 (パスワードなし — ログイン時に同期)
echo "$USERS_JSON" | jq -r '.users[] | "\(.uid) \(.username) \(.primary_gid) \(.groups) \(.is_admin)"' 2>/dev/null | \
while read -r uid username primary_gid groups is_admin; do
  [ -z "$uid" ] && continue
  if ! id "$username" > /dev/null 2>&1; then
    primary_group=$(getent group "$primary_gid" 2>/dev/null | cut -d: -f1 || echo "nogroup")
    adduser -D -u "$uid" -G "${primary_group:-nogroup}" -H -s /sbin/nologin "$username" 2>/dev/null || true
  fi
  echo "$groups" | tr ',' '\n' | while read -r grp; do
    [ -n "$grp" ] && addgroup "$username" "$grp" 2>/dev/null || true
  done
  if [ "$is_admin" = "true" ]; then
    addgroup "$username" las_admins 2>/dev/null || true
  fi
  # Samba ユーザー登録 (ダミーパスワード、実パスワードはログイン時に同期)
  if ! pdbedit -L 2>/dev/null | grep -q "^${username}:"; then
    echo -e "dummy_initial_pw\ndummy_initial_pw" | smbpasswd -a -s "$username" 2>/dev/null || true
  fi
done

echo "User sync complete."

# --- パスワード同期ループ ---
# バックエンドが LAS ログイン時に /smb-sync/{username}.passwd を書き出す。
# このループがファイルを検知して smbpasswd で Samba に反映する。
mkdir -p /smb-sync
(
  while true; do
    for f in /smb-sync/*.passwd; do
      [ -f "$f" ] || continue
      username=$(head -1 "$f")
      password=$(tail -1 "$f")
      if [ -n "$username" ] && [ -n "$password" ]; then
        if ! id "$username" > /dev/null 2>&1; then
          adduser -D -H -s /sbin/nologin "$username" 2>/dev/null || true
        fi
        echo -e "${password}\n${password}" | smbpasswd -a -s "$username" 2>/dev/null && \
          echo "Password synced for $username"
      fi
      rm -f "$f"
    done
    sleep 1
  done
) &

echo "Starting Samba..."
exec smbd --foreground --no-process-group --debug-stdout
```

> **パスワード同期の仕組み**: LAS バックエンドのログイン API (`POST /auth/login`) が成功時に `/smb-sync/{username}.passwd` にユーザー名とパスワードを書き出す。entrypoint.sh のバックグラウンドループが 1 秒間隔でファイルを検知し、`smbpasswd` で tdbsam に反映後、ファイルを削除する。パスワードファイルは最大 1 秒間ディスク上に存在する。

## バックエンド側の API (`GET /auth/smb-users`)

全アクティブユーザーと全グループの `unix_uid`/`unix_gid` を返す (Samba 起動時に一括取得):

```json
{
  "users": [
    {"uid": 10001, "username": "tanaka", "primary_gid": 20001, "groups": "sales,engineering", "is_admin": false},
    {"uid": 10002, "username": "suzuki", "primary_gid": 20002, "groups": "engineering", "is_admin": true}
  ],
  "groups": [
    {"gid": 20001, "name": "sales"},
    {"gid": 20002, "name": "engineering"}
  ]
}
```

認証: `X-Internal-Key` ヘッダーで内部 API キーを検証。キーは `.env` の `SMB_INTERNAL_KEY` で定義し、Samba コンテナと backend コンテナの両方に環境変数として渡す。nginx では `/api/auth/smb-users` と `/api/auth/smb-verify` を外部公開しない (internal 扱い)。

## 認証フロー

1. ユーザーが LAS Web UI にログイン (`POST /auth/login`)
2. バックエンドが `/smb-sync/{username}.passwd` にパスワードを書き出し
3. Samba entrypoint のバックグラウンドループが検知、`smbpasswd` で tdbsam 更新
4. 以降、SMB 接続は tdbsam で認証 (LAS API 不要)

**初回ログイン前のユーザー**: Samba 起動時に全ユーザーをダミーパスワードで登録。LAS Web UI にログインすると実パスワードに更新される。LAS ログイン前は SMB 接続不可。

## 権限マッピング

### アクセス制御方式: 可視性フィルタ + 書き込み権限チェック

FUSE の `readdir()` / `lookup()` / `open()` で可視性フィルタ (`_can_see_entry()`) を適用し、見えないエントリは存在しないかのように `ENOENT` を返す。書き込み操作 (`create`, `open(O_WRONLY)`, `unlink`, `rename`, `mkdir`, `rmdir`) では書き込み権限チェック (`_can_write_entry()` / `_can_write_folder_sync()`) を適用し、権限がない場合は `EACCES` を返す。

**可視性フィルタの理由**: `st_mode` ベースの制御では、同じファイルがユーザーごとに異なるパーミッションを返す必要があり、FUSE の仕組み上困難。可視性フィルタなら、アクセス制御は FUSE 層で完結する。

### 読み取りフィルタロジック (`_can_see_entry()`)

```
1. download_prohibited = True → 非表示 (ファイルのみ)
2. admin → 全て表示
3. owner (unix_uid 一致) → 表示
4. group_read + グループメンバー → 表示
5. others_read → 表示
6. それ以外 → 非表示 (ENOENT)
```

### 書き込み権限ロジック (`_can_write_entry()` / `_can_write_folder_sync()`)

```
1. admin → 許可
2. owner (unix_uid 一致) → 許可
3. group_write + グループメンバー → 許可
4. others_write → 許可
5. それ以外 → 拒否 (EACCES)
```

書き込み権限チェックの適用箇所:

| 操作 | チェック対象 | チェック関数 |
|------|------------|------------|
| `open(O_WRONLY/O_RDWR)` | 対象ファイルのエントリ | `_can_write_entry()` |
| `create()` | 親フォルダ | `_can_write_folder_sync()` |
| `unlink()` | 対象ファイルのエントリ | `_can_write_entry()` |
| `rename()` | ソース親フォルダ + ターゲット親フォルダ | `_can_write_folder_sync()` |
| `mkdir()` | 親フォルダ | `_can_write_folder_sync()` |
| `rmdir()` | 親フォルダ | `_can_write_folder_sync()` |

> ルートフォルダは認証済みユーザー全員に書き込みを許可。一時ファイルの `create()` は権限チェックをスキップ (エディタの動作を妨げないため)。

### ユーザー情報キャッシュ

`_get_user_info_sync()` が `unix_uid` → `(is_admin, グループ GID 集合)` を DB から取得し、TTL 30 秒でキャッシュ。`readdir()` の burst 時に DB 負荷を抑える。

### st_mode の扱い

`_compute_mode()` が owner/group/others の権限を `st_mode` に動的に反映:

| 種別 | owner | group | others |
|------|-------|-------|--------|
| ディレクトリ | 常時 `rwx` (0o700) | `group_read` → `r-x`, `group_write` → `+w` | `others_read` → `r-x`, `others_write` → `+w` |
| ファイル | 常時 `rw-` (0o600) | `group_read` → `r--`, `group_write` → `+w` | `others_read` → `r--`, `others_write` → `+w` |

### admin 権限

admin ユーザーは 2 重に保護:
- **FUSE 層**: `_can_see_entry()` で全エントリが可視
- **Samba 層**: `admin users = @las_admins` でファイルパーミッションに関係なくフルアクセス

### UID/GID 自動割り当て

`User.unix_uid` (10000~), `Group.unix_gid` (20000~) を自動採番。`_ensure_unix_uid()` / `_ensure_unix_gid()` が `MAX + 1` で割り当て。

## 書き込みアーキテクチャ: ステージング + pending マップ

### 課題

Office/TextEdit/Typora 等のエディタは save-rename パターンを使う:

1. `~$filename.docx` 作成 (ロック)
2. `filename.tmp` に全データ書き込み
3. `filename.docx` 削除
4. `filename.tmp` → `filename.docx` にリネーム
5. `~$filename.docx` 削除

FUSE コールバック内で直接 DB 操作を行うとこのパターンが破綻する (コールバックのブロック、不整合、パフォーマンス低下)。

### 解決策: ステージング書き込み + 非同期 DB 同期

```
SMB クライアント
    |
FUSE コールバック (create/write/rename/unlink)
    | DB 操作なし — ステージングディレクトリに書き込み
    | pending マップに登録
    |
バックグラウンドワーカー (_background_sync, 3秒間隔)
    | sync キューから取り出し
    | ステージング → UUID ストレージにコピー
    | Document + File レコード作成
    | document_processing ジョブ投入
```

### ステージング

- **ステージングディレクトリ**: `/data/smb-staging/{folder_id}/` (バインドマウント)
- `create()`: ステージングにファイルを作成し、`PendingFile` を登録
- `write()`: ステージングファイルに `pwrite()`
- `release()` (ファイルクローズ): `PendingFile.closed = True` にして sync キューに追加
- 起動時に `shutil.rmtree(_STAGING_PATH)` でクラッシュ時の残骸をクリーンアップ

### pending マップ

ステージング中のファイルが `readdir()` / `lookup()` で即座に見えるようにする仕組み。

- `_pending_files: dict[int, PendingFile]` — inode → PendingFile
- `readdir()`: DB のエントリ + pending マップのエントリをマージして返す
- `lookup()`: pending マップを先に検索、なければ DB から検索
- `rename()`: pending マップ内のエントリ名を変更 (DB 操作なし)
- `unlink()`: pending マップのエントリは `deleted = True` にマーク、DB ファイルは soft delete

### バックグラウンド同期 (`_background_sync`)

trio タスクとして `pyfuse3.main()` と並行実行:

1. 3 秒間隔で sync キューを確認
2. 一時ファイル (`_is_temp_file()`) はスキップ
3. `_commit_pending_sync()`:
   - ステージングファイルを `_final_storage_path()` (UUID ベース) にコピー
   - `PendingFile.staging_path` を最終パスに更新 (ファイルが消えないように)
   - `Document` + `File` レコードを DB に作成
   - `document_processing` ジョブを投入
4. 既存ファイルの上書き (rename で DB ファイルに書き戻された場合):
   - `_reindex_sync()` で再インデックス

### 一時ファイルフィルタ

**無視パターン** (Document レコードを作らない):

- ファイル: `~$*`, `*.tmp`, `.~lock.*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` (macOS resource fork)
- ディレクトリ: `.sb-*` (macOS TextEdit sandbox), `（.*で保存中の書類）` (Typora)

一時ファイルは `PendingFile.is_temp = True` で管理され、ステージングに書き込まれるが DB には同期されない。

### ファイルパスの安全性

`_final_storage_path()` は UUID + ファイル名で一意なパスを生成:

```
/data/storage/uploads/smb/{uuid}_{truncated_filename}{ext}
```

ファイル名の長さが 255 バイトを超えないよう、`max(1, 255 - 37 - len(ext))` でベース名を切り詰める。

## メタデータキャッシュ戦略

Explorer/Finder でフォルダを開くと `readdir` + `stat * N` + `getxattr * N` で大量の DB クエリが発生する。

### 現在の実装

- **readdir プリフェッチ**: `readdir()` 時に該当フォルダの全 Document を 1 クエリで取得し、`MetadataCache` に格納
- **stat キャッシュ**: readdir で取得済みのメタデータをそのまま返す。TTL 5 秒
- **LRU**: 最大 100 フォルダ分をキャッシュ。超過分は古い順に破棄
- **inode→parent 逆引き**: `_inode_to_parent` マップで `getattr()` を O(1) で処理 (親フォルダのキャッシュを直接参照)
- **getxattr**: macOS の `com.apple.FinderInfo` 等は空レスポンスを返す (`ENODATA`)

## クラッシュ回復

FUSE デーモンが死ぬと stale マウント (`Transport endpoint is not connected`) が残る。

対策:

- **起動コマンド**: `fusermount3 -uz /mnt/base/fs` でクリーンアップ後に再マウント (docker-compose.yml の command で実行)
- **ステージングクリーンアップ**: 起動時に `shutil.rmtree(_STAGING_PATH)` でクラッシュ時の残骸を削除
- **ヘルスチェック**: `stat /mnt/base/fs/.healthcheck` の応答確認 (FUSE デーモンが `.healthcheck` に対して即座にレスポンス)
- **Samba 連動再起動**: `depends_on: las-fuse: condition: service_healthy` で FUSE が死んだら Samba も再起動

## 並行アクセス

- **ファイルハンドル管理**: FUSE の `fh` はプロセスグローバルな int。`_open_files: dict[int, int]` (fh → real_fd) で管理
- **同一ファイル同時書き込み**: Samba 側の oplock で制御。FUSE 側では追加のロックは不要 (OS の fd レベルで安全)
- **sync DB**: pyfuse3 は trio ベースのため、asyncpg ではなく同期 SQLAlchemy (`psycopg2`) を使用。`pool_size=5, max_overflow=10`

## Unicode 正規化 (NFC/NFD 問題)

### 問題

macOS の Finder は NFD (Normalization Form Decomposition) でファイル名を送信する。Linux は NFC を使う。同じ「ガイド.pdf」が NFD と NFC で異なるバイト列になり、2 つの別ファイルとして認識される。

```
NFC: "ガイド.pdf"  → \u30AC\u30A4\u30C9.pdf (3 コードポイント)
NFD: "ガイド.pdf"  → \u30AB\u3099\u30A4\u30C8\u3099.pdf (5 コードポイント, 濁点分離)
```

### 対策: FUSE デーモンで NFC に正規化

`_nfc()` / `_nfc_bytes()` で全パス入口を NFC 正規化:

```python
def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)

def _nfc_bytes(b: bytes) -> bytes:
    return _nfc(b.decode("utf-8", errors="surrogateescape")).encode("utf-8", errors="surrogateescape")
```

適用箇所 (全 FUSE コールバック):
- `lookup(parent_inode, name)` — name を NFC 正規化してから DB 検索
- `readdir(inode, off)` — 返すファイル名を NFC で返す
- `create(parent_inode, name, ...)` — name を NFC 正規化してステージングに作成
- `rename(old_parent, old_name, new_parent, new_name)` — 両方 NFC 正規化
- `unlink(parent_inode, name)` — NFC 正規化
- `mkdir(parent_inode, name)` — NFC 正規化
- `getattr(inode)` — inode ベースなので正規化不要
- `open(inode, flags)` — inode ベースなので正規化不要

## 実装フェーズ

### Phase 0: PoC (Docker FUSE マウント共有の検証) — 完了

**目的**: FUSE + Docker + Samba の組み合わせが動くかの検証。

**成果物**:

1. 最小 FUSE デーモン (`backend/app/fuse_poc.py`):
   - `readdir("/")` で固定リスト (`["test.txt", "hello.pdf"]`) を返す
   - `getattr()` で固定サイズ/パーミッションを返す
   - `open()` + `read()` で固定文字列を返す
   - 書き込みは `EROFS`
2. Samba コンテナ (`samba/Dockerfile`, `samba/smb.conf`):
   - alpine + samba、固定ユーザーで認証
   - FUSE マウントを `/share` として公開
3. `docker-compose.yml` に `las-fuse` + `samba` サービス追加
4. `backend/Dockerfile` に `libfuse3-dev` + `fuse3` + `pkg-config` 追加
5. `backend/requirements.txt` に `pyfuse3` 追加

**検証結果**:

| 検証項目 | 結果 |
|---------|------|
| `rshared` / `rslave` マウント伝播 | サブディレクトリ方式で動作 (直接マウントは不可、`/mnt/base/fs` にマウントして伝播) |
| ホスト側の `mount --make-shared` | 必要 (`mount --bind` + `mount --make-shared` が前提) |
| `--device /dev/fuse` のみで `SYS_ADMIN` なし | **不可** (`privileged: true` が必要) |
| Samba コンテナから FUSE マウント内のファイルが見える | OK |
| SMB 経由でファイル一覧/読み取り | OK (`smbclient` で確認) |
| macOS から SMB 接続 | OK (Finder で確認) |
| FUSE デーモン再起動後に Samba が回復 | OK (stale マウントクリーンアップ + 再マウントで回復) |

**判明した設計変更点**:

1. **サブディレクトリ方式**: FUSE マウントはバインドマウントのサブディレクトリ (`/mnt/base/fs`) に行う必要がある。直接マウントでは伝播しない
2. **`privileged: true` が必要** (Phase 0 時点): `--device /dev/fuse` + `SYS_ADMIN` だけでは不十分だった。Phase 3 で `SYS_ADMIN` + `apparmor:unconfined` の組み合わせにより非特権化に成功
3. **ホスト側の前提条件**: `mount --bind` + `mount --make-shared` が必要
4. **macOS 互換**: `vfs objects = fruit` が必須 (ただし streams_xattr は FUSE 非対応のため netatalk で代替)
5. **FUSE に必要な追加コールバック**: `statfs()`, `getxattr()`, `listxattr()`, `access()` が必要 (PoC で判明)
6. **macOS Terminal の TCC 制限**: macOS Terminal から `ls` すると `Operation not permitted` になるが、Finder からは正常動作する。macOS のセキュリティ機構 (TCC) による制限。README に注記

### Phase 1: 読み取り専用 FUSE — 完了

- DB 連携の readdir, getattr, open, read
- 追加 FUSE コールバック: statfs, getxattr, listxattr, access, opendir, releasedir
- 可視性フィルタによるアクセス制御 (owner/group/others + download_prohibited)
- ユーザー情報キャッシュ (unix_uid → is_admin + グループ, TTL 30秒)
- 権限マッピング (unix_uid/unix_gid 自動採番)
- LAS ユーザー認証: tdbsam パスワード同期
- メタデータキャッシュ (LRU, TTL 5秒, 最大 100 フォルダ)
- inode→parent 逆引きマップ (getattr O(1) 化)
- Unicode NFC 正規化
- macOS 互換 (fruit VFS, netatalk metadata)
- Admin UI に SMB 設定項目追加 (`smb_enabled`, `smb_sync_deletes`)

### Phase 2: 書き込み対応 — 完了

- ステージング書き込み + pending マップ + バックグラウンド同期
- create, write, release, setattr (truncate + utime)
- unlink (pending → deleted マーク、DB → soft delete)
- rename (pending マップ内移動、DB → title/folder_id 更新 + 再インデックス)
- 一時ファイルフィルタ (ファイル + ディレクトリ)
- `document_processing` ジョブ投入
- フォルダ操作:
  - `mkdir(parent_inode, name)` → Folder レコード作成。owner = 操作ユーザー (`ctx.uid` から逆引き)。権限は親フォルダから継承
  - `rmdir(parent_inode, name)` → 空フォルダのみ許可 (配下に Document/子 Folder がある場合は `ENOTEMPTY`)。Folder レコードを soft delete
  - `rename()` でフォルダ間移動 → `Document.folder_id` を更新
- ステージング残骸のクラッシュリカバリ (起動時クリーンアップ)

### Phase 3: 強化 (一部完了)

1. ~~**書き込み権限チェック**~~ — **完了**: `_can_write_entry()` / `_can_write_folder_sync()` で owner/group/others の書き込み権限を検証。`open(O_WRONLY)`, `create()`, `unlink()`, `rename()`, `mkdir()`, `rmdir()` に適用。`st_mode` も `_compute_mode()` で動的に反映
2. **`smb_enabled` 設定の強制**: Admin UI に設定項目は存在するが、実際に FUSE/Samba の起動/停止を制御していない。設定値に基づいて las-fuse/samba コンテナの起動を制御する仕組みを追加
3. **Web UI → SMB キャッシュ無効化**: Web UI 側でファイル/フォルダを変更した際に FUSE デーモンのメタデータキャッシュを無効化する。Redis pub/sub (channel: `smb:cache_invalidate`) でフォルダ ID を通知し、FUSE デーモンが subscribe して該当キャッシュを破棄
4. **SMB → Web UI 通知**: SMB 経由でファイルを変更/追加した場合、Web UI 側が気づかない。FUSE デーモンの `release()` / `rename()` 後に Redis pub/sub (channel: `smb:file_changed`) で Web UI に通知し、WebSocket 経由でフォルダ一覧を自動リフレッシュ
5. **Unicode NFC マイグレーション**: LAS の既存 `Document.title` / `Folder.name` に NFC/NFD が混在している可能性がある。既存データを一括 NFC 正規化するマイグレーションを実施
6. **大ファイル性能テスト**: 数百 MB〜数 GB のファイルの read/write パフォーマンスを測定し、必要に応じてバッファサイズ等を調整
7. ~~**非特権 FUSE**~~ — **完了**: `privileged: true` を廃止し、`devices: /dev/fuse` + `cap_add: SYS_ADMIN` + `security_opt: apparmor:unconfined` に変更。FUSE マウントには AppArmor unconfined が必要 (テスト確認済み)

## 変更対象ファイル

| ファイル | 内容 |
|---------|------|
| `backend/app/fuse_poc.py` | Phase 0 PoC FUSE デーモン (固定データ) |
| `backend/app/fuse_server.py` | 本番 FUSE デーモン (DB 連携、キャッシュ、NFC 正規化、ステージング書き込み) |
| `backend/app/models.py` | `User.unix_uid`, `Group.unix_gid` カラム追加 |
| `backend/app/main.py` | `unix_uid`, `unix_gid` マイグレーション |
| `backend/app/routers/auth.py` | SMB 内部 API (`smb-verify`, `smb-users`) + パスワード同期 |
| `backend/app/services/settings.py` | SMB 設定項目 (`smb_enabled`, `smb_sync_deletes`) |
| `backend/Dockerfile` | `libfuse3-dev` + `fuse3` + `pkg-config` 追加 |
| `backend/requirements.txt` | `pyfuse3`, `psycopg2-binary` 追加 |
| `samba/Dockerfile` | alpine + samba + tini |
| `samba/smb.conf` | Samba 設定 (SMB3, tdbsam, fruit VFS) |
| `samba/entrypoint.sh` | ユーザー同期 + パスワード同期ループ |
| `scripts/setup-smb.sh` | ホスト側前提条件の自動設定 (bind mount + make-shared) |
| `docker-compose.yml` | `las-fuse` + `samba` サービス + `samba_data` named volume |
| `frontend/src/pages/AdminPage.tsx` | SMB 設定 UI 追加 |
| `README.md` / `README_ja.md` | SMB 機能の説明、セットアップ手順、接続ガイド |
