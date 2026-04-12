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

```yaml
las-fuse:
  volumes:
    - ./data/fuse-mount:/mnt/las-fuse:rshared  # ホストに伝播
  devices:
    - /dev/fuse
  cap_add:
    - SYS_ADMIN  # Phase 0 で非特権 FUSE の可否を検証

samba:
  volumes:
    - ./data/fuse-mount:/share:rslave  # ホスト経由で受け取る
```

ホスト側で `mount --make-shared` が必要な場合あり。Phase 0 で検証必須。

## セキュリティ

- SMB3 必須 (`server min protocol = SMB3`, `smb encrypt = required`)
- 認証: LAS バックエンドの `authenticate_user()` (bcrypt) に PAM 委譲
- ゲストアクセス無効 (`map to guest = never`)
- ClamAV: FUSE の `release()` (ファイルクローズ) でスキャントリガー
- SYS_ADMIN: FUSE コンテナのみに付与。Phase 0 で `--device /dev/fuse` のみで動くか検証し、可能なら SYS_ADMIN を外す
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
smb encrypt = required
security = user
map to guest = never
log level = 1
max log size = 1000

# --- 認証: PAM に委譲 ---
# Samba のデフォルト (tdbsam) ではなく PAM でパスワード検証する。
# smbpasswd -a はユーザー登録 (存在宣言) のために必要だが、
# パスワードはダミーで良い。実認証は PAM -> LAS API で行う。
passdb backend = tdbsam
auth methods = pam
obey pam restrictions = yes

# Unicode
unix charset = UTF-8
dos charset = UTF-8

# Performance
socket options = TCP_NODELAY IPTOS_LOWDELAY
read raw = yes
write raw = yes
use sendfile = yes
aio read size = 16384
aio write size = 16384

[LAS]
path = /share
browseable = yes
writable = yes
create mask = 0664
directory mask = 0775
force create mode = 0000
force directory mode = 0000
# admin ロールのユーザーはファイルパーミッションに関係なくフルアクセス
admin users = @las_admins
```

### samba/pam.d/samba (PAM 設定ファイル)

```
# パスワード認証を LAS API に委譲
auth    required    pam_exec.so expose_authtok /usr/local/bin/pam_las_auth.sh
account required    pam_permit.so
session required    pam_permit.so
```

- `expose_authtok`: パスワードを stdin 経由で `pam_las_auth.sh` に渡す
- `pam_permit.so`: account/session は常に許可 (認証は auth で完了)

### samba/entrypoint.sh (起動時ユーザー同期)

```sh
#!/bin/sh
set -e

# --- コンテナ再起動時の Unix ユーザー復元 ---
# LAS API からアクティブな全ユーザーとグループを取得し、
# Unix ユーザー/グループとして再作成する。
# これにより、コンテナ再起動で /etc/passwd がリセットされても
# Samba が正しい UID/GID で動作できる。

SMB_INTERNAL_KEY="${SMB_INTERNAL_KEY:?SMB_INTERNAL_KEY is required}"

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
  http://backend:8000/api/auth/smb-users)

# las_admins グループ作成 (admin users = @las_admins 用)
addgroup -g 19999 las_admins 2>/dev/null || true

# グループの同期
echo "$USERS_JSON" | jq -r '.groups[] | "\(.gid) \(.name)"' | \
while read gid name; do
  if ! getent group "$name" > /dev/null 2>&1; then
    addgroup -g "$gid" "$name" 2>/dev/null || true
  fi
done

# ユーザーの同期
echo "$USERS_JSON" | jq -r '.users[] | "\(.uid) \(.username) \(.primary_gid) \(.groups) \(.is_admin)"' | \
while read uid username primary_gid groups is_admin; do
  if ! id "$username" > /dev/null 2>&1; then
    primary_group=$(getent group "$primary_gid" | cut -d: -f1)
    adduser -D -u "$uid" -G "${primary_group:-nogroup}" -H -s /sbin/nologin "$username" 2>/dev/null || true
  fi
  # サブグループに追加
  echo "$groups" | tr ',' '\n' | while read grp; do
    [ -n "$grp" ] && addgroup "$username" "$grp" 2>/dev/null || true
  done
  # admin ユーザーを las_admins グループに追加
  if [ "$is_admin" = "true" ]; then
    addgroup "$username" las_admins 2>/dev/null || true
  fi
  # Samba ユーザー登録 (認証は PAM 経由なのでパスワードはダミー)
  echo -e "dummy_pass\ndummy_pass" | smbpasswd -a -s "$username" 2>/dev/null || true
done

echo "User sync complete. Starting Samba..."
exec smbd --foreground --no-process-group --debug-stdout
```

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

## 実行時の PAM 認証フロー (新規ユーザーにも対応)

Samba の PAM 認証スクリプト (`pam_las_auth.sh`) は、起動時に存在しなかったユーザー (後から LAS に登録された) にも対応する:

1. PAM が `pam_las_auth.sh` を呼び出し
2. `curl POST /auth/smb-verify` で認証
3. 成功 + ユーザーが `/etc/passwd` に未登録なら `useradd` で動的作成
4. グループも同様に動的追加
5. `exit 0` で Samba にログイン許可

## 権限マッピング

| LAS | Unix/SMB | chmod 計算 |
|-----|----------|------------|
| `owner_id` | file uid (`unix_uid`) | 常に rw (`0o600`) |
| `group_id` + `group_read` | file gid (`unix_gid`) + `g+r` | `+0o040` |
| `group_id` + `group_write` | file gid + `g+w` | `+0o020` |
| `others_read` | `o+r` | `+0o004` |
| `others_write` | `o+w` | `+0o002` |
| admin ロール | smb.conf の `admin users = @las_admins` | Samba 側で制御 |

admin 権限は FUSE の `getattr()` ではなく Samba の `admin users` ディレクティブで処理する。`getattr()` はファイル固有の権限 (owner/group/others) のみ返す。admin ユーザーは Samba 側でファイルパーミッションに関係なくフルアクセスが許可される。これにより、同じファイルが見る人によって違う `st_mode` を返す問題を回避。

`User.unix_uid` (10000~), `Group.unix_gid` (20000~) を自動割り当て。

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

### Phase 0: PoC (Docker FUSE マウント共有の検証)

**目的**: FUSE + Docker + Samba の組み合わせが動くかの検証。ここがダメなら全体計画を見直す。

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
4. PC から SMB 接続してファイル一覧とファイル読み取りを確認

**検証項目**:
- `rshared` / `rslave` マウント伝播が動作するか
- ホスト側の `mount --make-shared` が必要か
- `--device /dev/fuse` のみで `SYS_ADMIN` なしで動くか
- Samba コンテナから FUSE マウント内のファイルが見えるか
- PC から SMB 経由でファイル一覧/読み取りができるか
- FUSE デーモン再起動後に Samba が回復するか

### Phase 1: 読み取り専用 FUSE (PoC 成功後)

- DB 連携の readdir, getattr, open, read
- 権限マッピング (unix_uid/unix_gid + chmod)
- LAS ユーザー認証 PAM
- メタデータキャッシュ
- Unicode NFC 正規化

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

## Phase 0 の変更対象ファイル

| ファイル | 内容 |
|---------|------|
| `backend/app/fuse_poc.py` | 新規 - 最小 FUSE デーモン (固定データ) |
| `samba/Dockerfile` | 新規 - alpine + samba |
| `samba/smb.conf` | 新規 - 最小 Samba 設定 (SMB3, 固定ユーザー) |
| `docker-compose.yml` | `las-fuse` + `samba` サービス追加 |
| `backend/requirements.in` | `pyfuse3` 追加 |

## Phase 0 の検証手順

```bash
# 1. ビルド & 起動
docker compose up -d --build las-fuse samba

# 2. FUSE マウントの確認 (las-fuse コンテナ内)
docker compose exec las-fuse ls -la /mnt/las-fuse/

# 3. Samba コンテナからの確認
docker compose exec samba ls -la /share/

# 4. PC から SMB 接続
#    Windows: \\<server-ip>\LAS
#    macOS:   smb://<server-ip>/LAS
#    Linux:   mount -t cifs //<server-ip>/LAS /mnt/test -o username=test

# 5. ファイル一覧と読み取りの確認
# 6. FUSE デーモン再起動テスト
docker compose restart las-fuse
# 30秒待ってから再度 SMB 接続確認
```
