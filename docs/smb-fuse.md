# SMB ファイル共有機能の追加 (FUSE 仮想 FS アプローチ)

## Context

LAS に Samba コンテナを追加し、FUSE 仮想ファイルシステム経由でファイルを SMB 共有する。FUSE デーモンが DB を参照して LAS のフォルダ構造/ファイル名の仮想ビューを生成し、実際の I/O は既存の UUID ベースストレージに透過的にリダイレクトする。既存のストレージ構造もバックエンドコードも変更不要。

## アーキテクチャ

```
PC (SMB, LAS ユーザー ID/PW)
    |
Samba コンテナ (/share = FUSE マウントを rslave で参照)
    |
FUSE デーモン (/mnt/las-fuse, rshared でホストに伝播)
    | DB クエリでパス解決 + 実ファイルに I/O リダイレクト
./data/storage/uploads/{uid}/{uuid}_filename  (既存ストレージそのまま)
```

## Docker マウント伝播 (named volume ではなくバインドマウント)

FUSE マウントはバインドマウントのサブディレクトリに行う必要がある。直接マウントでは伝播しない。

```yaml
las-fuse:
  volumes:
    - ./data/fuse-mount:/mnt/base:rshared  # ホストに伝播
  devices:
    - /dev/fuse
  privileged: true  # --device /dev/fuse + SYS_ADMIN では不十分 (Phase 0 で確認済み)

samba:
  volumes:
    - ./data/fuse-mount:/share:rslave  # ホスト経由で受け取る
```

FUSE デーモンは `/mnt/base/fs` にマウントし、Samba は `/share/fs` を参照する。

**ホスト側の前提条件** (セットアップスクリプトまたは README に記載):

```bash
sudo mkdir -p ./data/fuse-mount
sudo mount --bind ./data/fuse-mount ./data/fuse-mount
sudo mount --make-shared ./data/fuse-mount
```

> **Phase 1 TODO**: `privileged: true` は過剰な権限付与のため、非特権 FUSE の代替手段 (`/dev/fuse` + 必要最小限の capability) を再検討する。

## セキュリティ

- SMB3 必須 (`server min protocol = SMB3`, `smb encrypt = required`)
- 認証: LAS バックエンドの `authenticate_user()` (bcrypt) に PAM 委譲
- ゲストアクセス無効 (`map to guest = never`)
- ClamAV: FUSE の `release()` (ファイルクローズ) でスキャントリガー
- `privileged: true`: FUSE コンテナに必要 (`--device /dev/fuse` + `SYS_ADMIN` だけでは不十分、Phase 0 で確認済み)。Phase 1 以降で非特権 FUSE の代替手段を再検討
- ポート 445: LAN/VPN 内のみ公開。README にファイアウォール設定を記載

## Samba コンテナ設計 (自前ビルド)

dperson/samba は最終更新が数年前でセキュリティパッチが適用されない。`alpine:latest` ベースで自前ビルドする。

### samba/Dockerfile

```dockerfile
FROM alpine:3.21
RUN apk add --no-cache \
    samba \
    samba-common-tools \
    linux-pam \
    curl \
    jq \
    shadow \
    tini
COPY smb.conf /etc/samba/smb.conf
COPY pam.d/samba /etc/pam.d/samba
COPY pam_las_auth.sh /usr/local/bin/pam_las_auth.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/pam_las_auth.sh /entrypoint.sh
EXPOSE 445
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]
```

パッケージの役割:
- `samba`: SMB サーバー本体
- `samba-common-tools`: smbpasswd, pdbedit 等の管理ツール
- `linux-pam`: PAM 認証基盤
- `curl` + `jq`: PAM 認証スクリプトから LAS API を呼ぶため
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

# --- 認証: tdbsam + パスワード同期 ---
# LAS バックエンドでログイン時にパスワードをファイル経由で Samba に同期する。
# PAM は新規ユーザーの動的作成に使用 (pam_las_auth.sh)。
passdb backend = tdbsam
obey pam restrictions = no

# Charset
unix charset = UTF-8
dos charset = CP932

# Performance
socket options = TCP_NODELAY IPTOS_LOWDELAY
read raw = yes
write raw = yes
use sendfile = yes
aio read size = 16384
aio write size = 16384

# macOS compatibility
vfs objects = fruit streams_xattr
fruit:metadata = stream
fruit:model = MacSamba
fruit:nfs_aces = no

[LAS]
path = /share-base/fs
browseable = yes
read only = yes
admin users = @las_admins
```

> **設計からの変更点 (Phase 1 で判明)**:
> - `smb encrypt`: `required` → `desired` (LAN 内利用で暗号化非対応クライアントとの互換性を確保)
> - `dos charset`: `UTF-8` → `CP932` (Windows 日本語環境との互換性向上)
> - 認証方式: PAM 委譲 → tdbsam + パスワードファイル同期 (より安定)
> - `path`: `/share` → `/share-base/fs` (サブディレクトリ方式に対応)
> - Phase 1 は `read only = yes` (Phase 2 で `writable = yes` に変更予定)
> - `fruit:metadata = stream`, `fruit:model = MacSamba`, `fruit:nfs_aces = no` を追加 (macOS 互換性向上)

### samba/pam.d/samba (PAM 設定ファイル)

```
# パスワード認証を LAS API に委譲
auth    required    pam_exec.so expose_authtok /usr/local/bin/pam_las_auth.sh
account required    pam_permit.so
session required    pam_permit.so
```

- `expose_authtok`: パスワードを stdin 経由で `pam_las_auth.sh` に渡す
- `pam_permit.so`: account/session は常に許可 (認証は auth で完了)

### samba/entrypoint.sh (起動時ユーザー同期 + パスワード同期ループ)

```sh
#!/bin/sh
set -e
export SMB_INTERNAL_KEY

# --- コンテナ再起動時の Unix ユーザー復元 ---
# LAS API からアクティブな全ユーザーとグループを取得し、
# Unix ユーザー/グループとして再作成する。

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

### 通常フロー (パスワード同期方式)

1. ユーザーが LAS Web UI にログイン (`POST /auth/login`)
2. バックエンドが `/smb-sync/{username}.passwd` にパスワードを書き出し
3. Samba entrypoint のバックグラウンドループが検知、`smbpasswd` で tdbsam 更新
4. 以降、SMB 接続は tdbsam で認証 (LAS API 不要)

### 新規ユーザーフロー (PAM フォールバック)

起動後に LAS に追加されたユーザーが SMB 接続した場合:

1. PAM が `pam_las_auth.sh` を呼び出し
2. `curl POST /auth/smb-verify` で LAS API に認証委譲
3. 成功 + ユーザーが `/etc/passwd` に未登録なら `useradd` で動的作成
4. グループも同様に動的追加
5. `smbpasswd -a` で tdbsam に登録
6. `exit 0` で Samba にログイン許可

## 権限マッピング

### アクセス制御方式: 可視性フィルタ

`st_mode` で Unix パーミッションを表現する代わりに、FUSE の `readdir()` / `lookup()` / `open()` で可視性フィルタ (`_can_see_entry()`) を適用する方式を採用。見えないエントリは存在しないかのように `ENOENT` を返す。

**理由**: `st_mode` ベースの制御では、同じファイルがユーザーごとに異なるパーミッションを返す必要があり、FUSE の仕組み上困難。可視性フィルタなら、`st_mode` は固定値 (`0o755` / `0o644`) で統一でき、アクセス制御は FUSE 層で完結する。

### フィルタロジック (`_can_see_entry()`)

```
1. download_prohibited = True → 非表示 (ファイルのみ)
2. admin → 全て表示
3. owner (unix_uid 一致) → 表示
4. group_read + グループメンバー → 表示
5. others_read → 表示
6. それ以外 → 非表示 (ENOENT)
```

### ユーザー情報キャッシュ

`_get_user_info_sync()` が `unix_uid` → `(is_admin, グループ GID 集合)` を DB から取得し、TTL 30 秒でキャッシュ。`readdir()` の burst 時に DB 負荷を抑える。

### st_mode の扱い

| 種別 | st_mode | 備考 |
|------|---------|------|
| ディレクトリ | `0o755` | 固定。可視性フィルタで制御 |
| ファイル | `0o644` | 固定。可視性フィルタで制御 |

Phase 2 (書き込み対応) で、書き込み権限のあるエントリには `0o755` / `0o666` を返すように拡張予定。

### admin 権限

admin ユーザーは 2 重に保護:
- **FUSE 層**: `_can_see_entry()` で全エントリが可視
- **Samba 層**: `admin users = @las_admins` でファイルパーミッションに関係なくフルアクセス

### UID/GID 自動割り当て

`User.unix_uid` (10000~), `Group.unix_gid` (20000~) を自動採番。`_ensure_unix_uid()` / `_ensure_unix_gid()` が `MAX + 1` で割り当て。

## 一時ファイル処理方針

Office 等の save-rename パターン:

1. `~$filename.docx` 作成 (ロック)
2. `filename.tmp` に全データ書き込み
3. `filename.docx` 削除
4. `filename.tmp` → `filename.docx` にリネーム
5. `~$filename.docx` 削除

### FUSE デーモンの対応

**無視パターン** (Document レコードを作らない): `~$*`, `*.tmp`, `.~lock.*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*` (macOS resource fork)

**削除+リネームの非同期遅延処理**:

- `unlink()` は即座に return する (FUSE コールバックをブロックしない)
- バックグラウンドで 500ms の遅延タイマーを設定:

```python
async def unlink(self, parent_inode, name, ctx):
    doc = await self._lookup_doc(parent_inode, name)
    # 即座に return、バックグラウンドで遅延削除
    self._pending_deletes[doc.id] = asyncio.get_event_loop().call_later(
        0.5, lambda: asyncio.ensure_future(self._execute_delete(doc.id))
    )

async def rename(self, old_parent, old_name, new_parent, new_name, flags, ctx):
    doc = await self._lookup_doc(old_parent, old_name)
    # pending delete があればキャンセル
    if doc.id in self._pending_deletes:
        self._pending_deletes[doc.id].cancel()
        del self._pending_deletes[doc.id]
    # source_path を新ファイルに更新、再インデックス
    ...
```

- `rename()` が来たら pending delete をキャンセルし、Document の `source_path` を更新 + 再インデックス
- 500ms 以内に `rename()` が来なければ soft delete 確定

**ファイルハンドルマッピング**: `fh -> {real_fd, doc_id, user_context, is_temp}` のディクショナリで管理。`is_temp=True` のハンドルは DB 操作をスキップ。

## メタデータキャッシュ戦略

Explorer/Finder でフォルダを開くと `readdir` + `stat * N` + `getxattr * N` で大量の DB クエリが発生する。

対策:

- **readdir プリフェッチ**: `readdir()` 時に該当フォルダの全 Document (`id`, `title`, `source_path`, `owner`, `group`, `permissions`, `file_size`, `updated_at`) を 1 クエリで取得し、メモリキャッシュに格納
- **stat キャッシュ**: readdir で取得済みのメタデータをそのまま返す。TTL 5 秒
- **キャッシュ無効化**: Web UI 側の変更時に Redis pub/sub (channel: `smb:cache_invalidate`) でフォルダ ID を通知。FUSE デーモンが subscribe して該当キャッシュを破棄
- **getxattr**: macOS の `com.apple.FinderInfo` 等は空レスポンスを返す (`ENODATA`)

### 追加考慮事項

- **SMB → Web UI 方向の通知**: SMB 経由でファイルを変更/追加した場合、Web UI 側が気づかない。FUSE デーモンの `release()` / `rename()` 後に同じ Redis pub/sub (channel: `smb:file_changed`) で Web UI にも通知する。Web UI 側は WebSocket 経由でフォルダ一覧を自動リフレッシュ
- **キャッシュのメモリ上限**: 数千ファイルのフォルダが複数同時にアクセスされるとメモリ消費が大きくなる。LRU で最大フォルダ数を制限する (例: 直近 100 フォルダ分)
- **Redis ダウン時のフォールバック**: Redis が落ちるとキャッシュ無効化が届かない。TTL 5 秒があるので致命的ではないが、Redis 接続エラー時は TTL を 1 秒に短縮して整合性を優先する
- **負の stat キャッシュ**: 存在しないファイルへの `lookup()` (Office の一時ファイル探索など) が毎回 DB に行く。「存在しない」も TTL 2 秒でキャッシュして DB 負荷を軽減する

これらは Phase 1 以降で段階的に対応する。Phase 0 (PoC) ではキャッシュなしで動作確認し、実測してボトルネックを確認してから最適化する。

## クラッシュ回復

FUSE デーモンが死ぬと stale マウント (`Transport endpoint is not connected`) が残る。

対策:

- **起動スクリプト**: `fusermount -u /mnt/las-fuse 2>/dev/null; exec python -m app.fuse_server` でクリーンアップ後に再マウント
- **ヘルスチェック**: `stat /mnt/las-fuse/.healthcheck` の応答確認 (FUSE デーモンが `.healthcheck` に対して即座にレスポンス)
- **Samba 連動再起動**: `depends_on: las-fuse: condition: service_healthy` で FUSE が死んだら Samba も再起動

## 並行アクセス

- **ファイルハンドル管理**: FUSE の `fh` はプロセスグローバルな int。`dict[int, FileHandle]` で管理。`FileHandle = {real_fd, doc_id, user_uid, is_temp, lock}`
- **同一ファイル同時書き込み**: Samba 側の oplock で制御。FUSE 側では追加のロックは不要 (OS の fd レベルで安全)
- **asyncpg コネクションプール**: `min_size=5, max_size=20` で設定。readdir の burst に対応

## Unicode 正規化 (NFC/NFD 問題)

### 問題

macOS の Finder は NFD (Normalization Form Decomposition) でファイル名を送信する。Linux は NFC を使う。同じ「ガイド.pdf」が NFD と NFC で異なるバイト列になり、2 つの別ファイルとして認識される。

```
NFC: "ガイド.pdf"  → \u30AC\u30A4\u30C9.pdf (3 コードポイント)
NFD: "ガイド.pdf"  → \u30AB\u3099\u30A4\u30C8\u3099.pdf (5 コードポイント, 濁点分離)
```

### 対策: FUSE デーモンで NFC に正規化

FUSE デーモンの全パス入口で NFC 正規化を適用:

```python
import unicodedata

def _normalize_path(path: str) -> str:
    """全てのパスを NFC に正規化。macOS NFD との差異を吸収。"""
    return unicodedata.normalize('NFC', path)
```

適用箇所 (全 FUSE コールバック):
- `lookup(parent_inode, name)` — name を NFC 正規化してから DB 検索
- `readdir(inode, off)` — 返すファイル名を NFC で返す
- `create(parent_inode, name, ...)` — name を NFC 正規化して Document 作成
- `rename(old_parent, old_name, new_parent, new_name)` — 両方 NFC 正規化
- `unlink(parent_inode, name)` — NFC 正規化
- `getattr(inode)` — inode ベースなので正規化不要
- `open(inode, flags)` — inode ベースなので正規化不要

### DB 側の正規化

LAS の既存 `Document.title` は NFC/NFD が混在している可能性がある。

- Phase 1 で既存データの NFC マイグレーション実施:

```sql
-- PostgreSQL の normalize() は 15+ で利用可能
UPDATE documents SET title = normalize(title, NFC) WHERE title != normalize(title, NFC);
UPDATE folders SET name = normalize(name, NFC) WHERE name != normalize(name, NFC);
```

- 今後の INSERT/UPDATE でも NFC 正規化をアプリ層で適用 (DB 側の制約だけに頼らない)

### Samba 側の設定

```ini
[global]
# macOS からのファイル名を Samba 側でも正規化
mangled names = no
unix charset = UTF-8
dos charset = UTF-8
```

注: Samba 自体には NFC/NFD 正規化機能がないため、FUSE 層での処理が必須。

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

1. **サブディレクトリ方式**: FUSE マウントはバインドマウントのサブディレクトリ (`/mnt/base/fs`) に行う必要がある。直接マウントでは伝播しない → アーキテクチャセクションに反映済み
2. **`privileged: true` が必要**: `--device /dev/fuse` + `SYS_ADMIN` だけでは不十分 → セキュリティセクションに反映済み。Phase 1 以降で非特権 FUSE の代替手段を再検討
3. **ホスト側の前提条件**: `mount --bind` + `mount --make-shared` が必要 → Docker マウント伝播セクションに反映済み
4. **macOS 互換**: `vfs objects = fruit streams_xattr` が必須 → smb.conf に反映済み
5. **FUSE に必要な追加コールバック**: `statfs()`, `getxattr()`, `listxattr()`, `access()` が必要 (PoC で判明)。Phase 1 の実装スコープに含める
6. **macOS Terminal の TCC 制限**: macOS Terminal から `ls` すると `Operation not permitted` になるが、Finder からは正常動作する。Samba/FUSE の問題ではなく macOS のセキュリティ機構 (TCC) による制限。README に注記

### Phase 1: 読み取り専用 FUSE — 完了

- DB 連携の readdir, getattr, open, read
- 追加 FUSE コールバック: statfs, getxattr, listxattr, access, opendir, releasedir
- 可視性フィルタによるアクセス制御 (owner/group/others + download_prohibited)
- ユーザー情報キャッシュ (unix_uid → is_admin + グループ, TTL 30秒)
- 権限マッピング (unix_uid/unix_gid 自動採番)
- LAS ユーザー認証: tdbsam パスワード同期 + PAM フォールバック
- メタデータキャッシュ (LRU, TTL 5秒, 最大 100 フォルダ)
- Unicode NFC 正規化
- macOS 互換 (fruit VFS)
- Admin UI に SMB 設定項目追加 (`smb_enabled`, `smb_sync_deletes`)

### Phase 2: 書き込み対応

- create, write, release, unlink, rename (ファイル)
- 一時ファイルフィルタ
- Office save-rename パターン対応 (非同期遅延削除)
- ClamAV スキャン (release 時)
- `document_processing` ジョブ投入
- フォルダ操作:
  - `mkdir(parent_inode, name)` → Folder レコード作成。owner = 操作ユーザー (`ctx.uid` から逆引き)。権限は親フォルダから継承
  - `rmdir(parent_inode, name)` → 空フォルダのみ許可 (配下に Document/子 Folder がある場合は `ENOTEMPTY`)。Folder レコードを soft delete
  - `rename()` でフォルダ間移動 → `Document.folder_id` を更新。移動先フォルダの権限を継承するかは既存 LAS の動作に合わせる (現在は継承しない = ファイル個別の権限を維持)

### Phase 3: 安定化

- クラッシュ回復 (stale マウント対策)
- 並行アクセステスト
- 大ファイル性能テスト
- Admin UI 設定

## 変更対象ファイル (Phase 0 + Phase 1 実施済み)

| ファイル | 内容 |
|---------|------|
| `backend/app/fuse_poc.py` | Phase 0 PoC FUSE デーモン (固定データ) |
| `backend/app/fuse_server.py` | Phase 1 本番 FUSE デーモン (DB 連携、キャッシュ、NFC 正規化) |
| `backend/app/models.py` | `User.unix_uid`, `Group.unix_gid` カラム追加 |
| `backend/app/main.py` | `unix_uid`, `unix_gid` マイグレーション |
| `backend/app/routers/auth.py` | SMB 内部 API (`smb-verify`, `smb-users`) + パスワード同期 |
| `backend/app/services/settings.py` | SMB 設定項目 (`smb_enabled`, `smb_sync_deletes`) |
| `backend/Dockerfile` | `libfuse3-dev` + `fuse3` + `pkg-config` 追加 |
| `backend/requirements.txt` | `pyfuse3`, `psycopg2-binary` 追加 |
| `samba/Dockerfile` | alpine + samba + PAM + tini |
| `samba/smb.conf` | Samba 設定 (SMB3, tdbsam, fruit VFS) |
| `samba/entrypoint.sh` | ユーザー同期 + パスワード同期ループ |
| `samba/pam_las_auth.sh` | PAM 認証スクリプト (新規ユーザー動的作成) |
| `samba/pam.d/samba` | PAM 設定 |
| `docker-compose.yml` | `las-fuse` + `samba` サービス追加 |
| `frontend/src/pages/AdminPage.tsx` | SMB 設定 UI 追加 |
