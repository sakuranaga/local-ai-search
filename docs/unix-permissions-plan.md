# Unix風パーミッション実装計画

## Context

現在の権限モデル（Admin/Editor/Viewer ロール × document_permissions テーブルの per-user ACL）は非技術者にわかりにくく、検索・AIエージェントでの権限チェックも未実装。Unix風の owner/group/others × rw に置き換え、シンプルかつ直感的なアクセス制御を実現する。

## 設計方針

- **パーミッション**: 各ドキュメントに `owner(rw固定)` / `group(rw)` / `others(rw)` を持たせる
- **ロール**: Admin/User の2種。Admin = root（全アクセス）
- **グループ**: 新テーブル。管理画面でCRUD + メンバー管理
- **フォルダ権限**: フォルダに設定 → 中のファイルに一括適用（実行時の継承ではない）
- **検索・AI**: DB レベルの visibility filter で権限を強制
- **非表示**: 読み権限がないドキュメントは一覧・検索結果に一切表示しない（Unixと違い、存在自体が見えない）

---

## Phase 0: ロール簡素化（Admin/User の2つに）

### バックエンド
- マイグレーション: editor/viewer ロールのユーザーを user ロールに移行し、旧ロール削除
- `_is_admin()` はそのまま。Editor/Viewer 固有のチェックがあれば削除
- `deps.py`: role チェックがあれば Admin/User のみに簡素化

### フロントエンド (`frontend/src/pages/AdminPage.tsx`)
- ロール管理タブ: Admin/User のみ表示。ロール作成は不要に（または残すが非推奨）
- ユーザー編集: ロール選択を Admin/User のドロップダウンに

---

## Phase 1: DBモデル + マイグレーション

### 新テーブル
- `groups` (id UUID PK, name, description, created_at, updated_at)
- `group_members` (id, group_id FK, user_id FK, unique(group_id, user_id), created_at)

### Document モデル変更 (`backend/app/models.py`)
- 追加: `group_id` FK, `group_read` bool, `group_write` bool, `others_read` bool, `others_write` bool
- `is_public` → `others_read` にマイグレーション後、`is_public` 削除
- `permissions` リレーション削除（DocumentPermission テーブル廃止）

### Folder モデル変更
- 追加: `owner_id` FK, `group_id` FK, `group_read`, `group_write`, `others_read`, `others_write`
- ファイルと同じ Unix パーミッション構造。**読み権限がないフォルダはサイドバーに非表示**
- フォルダの権限変更 → 中の全ファイルに同じ権限を一括適用
- ファイルをフォルダ間で移動 → 移動先フォルダの権限を自動適用

### マイグレーション (`backend/app/main.py` init_db)
1. `groups`, `group_members` テーブル作成
2. `documents` に新カラム追加（ALTER TABLE ADD COLUMN IF NOT EXISTS）
3. `folders` に新カラム追加
4. `UPDATE documents SET others_read = is_public`
5. ロール統合: editor/viewer → user に変更
6. `document_permissions` テーブル削除（段階的に）

---

## Phase 2: 権限チェックユーティリティ

### 新ファイル: `backend/app/services/permissions.py`

```python
def is_admin(user: User) -> bool
def get_user_group_ids(user: User) -> list[UUID]
def can_access_document(doc: Document, user: User, need_write: bool = False) -> bool
    # admin → 全許可
    # owner → rw固定
    # group member → group_read/group_write
    # others → others_read/others_write
def build_visibility_filter(user: User) -> SQLAlchemy BooleanClause
    # admin → フィルタなし
    # else → OR(owner, group+group_read, others_read)
```

---

## Phase 3: Document エンドポイント更新 (`backend/app/routers/documents.py`)

- `_is_admin()`, `_check_doc_access()` → `permissions.py` に移行
- `list_documents`: visibility_filter を Unix 版に置換。`perm_sq` サブクエリ削除。**読み権限がない文書は文書管理画面に表示しない**（ファイル名含め完全非表示）
- レスポンスモデル: `is_public` → `group_id, group_name, group_read, group_write, others_read, others_write`
- `upload_document`: フォルダの権限をコピー（フォルダに設定がある場合）
- 権限エンドポイント: per-user ACL → Unix フィールドの PATCH に変更
- `bulk_action set_permissions`: Unix フィールドの一括更新に変更

---

## Phase 4: Groups API

### 新ファイル: `backend/app/routers/groups.py`

| メソッド | パス | 説明 | 権限 |
|----------|------|------|------|
| GET | /groups | グループ一覧 | 全員（admin=全部, user=所属のみ） |
| POST | /groups | 作成 | admin |
| PATCH | /groups/{id} | 更新 | admin |
| DELETE | /groups/{id} | 削除（文書のgroup_id=NULLに） | admin |
| GET | /groups/{id}/members | メンバー一覧 | 全員 |
| POST | /groups/{id}/members | メンバー追加 | admin |
| DELETE | /groups/{id}/members/{user_id} | メンバー削除 | admin |

`main.py` にルーター登録。

---

## Phase 5: フォルダ権限の一括適用

### `backend/app/routers/folders.py`

- フォルダの更新で権限フィールド（owner_id, group_id, group_read, group_write, others_read, others_write）をセット可能に
- フォルダの権限変更時 → 中の全ドキュメントに同じ権限を自動適用
- `recursive=true` で子フォルダ + そのドキュメントにも適用
- アップロード時: フォルダの権限をコピー
- **ファイル移動時**: 移動先フォルダの権限を自動適用（`documents.py` の move 処理を更新）
- フォルダ一覧 API: `build_visibility_filter` でフォルダも権限フィルタ（読み権限がないフォルダは非表示）

---

## Phase 6: 検索の権限フィルタ (`backend/app/services/search.py`)

全検索関数に `user: User | None` パラメータ追加:
- `fulltext_search()`
- `vector_search()`
- `merged_search()`
- `title_search()`
- `grep_search()`

`build_visibility_filter(user)` を WHERE に追加。Chunk → Document の JOIN は既存。

`backend/app/routers/search.py` から `current_user` を渡す。

---

## Phase 7: AIエージェントの権限チェック (`backend/app/services/ai_agent.py`)

- `run_agent()` に `user: User` パラメータ追加
- `_execute_tool()` で user を各ツールに渡す
- `search`, `grep`, `search_by_title` → 検索関数に user を渡す
- `read_document` → `can_access_document()` でチェック、拒否時「アクセス権限がありません」
- `backend/app/routers/chat.py` から `current_user` を渡す

---

## Phase 8: フロントエンド

### 8a. API (`frontend/src/lib/api.ts`)
- Group 型・API関数追加
- Document 型に Unix 権限フィールド追加
- `getDocumentPermissions`, `setDocumentPermissions` → 削除
- `is_public` → `others_read` に置換

### 8b. 権限表示・編集UI (`frontend/src/pages/FileExplorerPage.tsx`)
- PermissionsTab を Unix 風に刷新:
  ```
  オーナー: [ユーザー名]  rw（固定）
  グループ: [ドロップダウン]  ☐読 ☐書
  全員:                      ☐読 ☐書
  サマリー: rw-r-----
  ```
- BulkPermissionsDialog も同様に変更
- ファイル一覧にパーミッション表示列追加（`rw-r--r--` 形式）

### 8c. グループ管理 (`frontend/src/pages/AdminPage.tsx`)
- 「グループ」タブ追加
- グループ一覧（名前、説明、メンバー数）
- グループ作成・編集・削除
- メンバー管理（追加/削除）

### 8d. ロール簡素化
- Admin/User の2つのみに。UIで明示

---

## 実装順序

1. **Phase 0（ロール簡素化）**: Admin/Editor/Viewer → Admin/User に統合。これを最初にやることで後続フェーズが Admin/User だけを前提に書ける
2. Phase 1（DB）→ 2（権限ユーティリティ）→ 3（Document API）
3. Phase 4（Groups API）→ 5（フォルダ一括適用）
4. Phase 6（検索フィルタ）→ 7（AIエージェント）
5. Phase 8（フロントエンド）

---

## エッジケース

| ケース | 対応 |
|--------|------|
| group_id が NULL | グループ権限は無視、othersで判定 |
| グループ削除 | 文書の group_id = NULL に |
| ユーザーをグループから除外 | リアルタイム判定、データ移行不要 |
| アップロード先フォルダに権限設定あり | フォルダの権限をコピー |
| `is_public` 後方互換 | `others_read` にマイグレーション後削除 |
| 読み権限なしの文書 | 文書管理の一覧・検索結果・AI全てで完全非表示（ファイル名も見えない） |
| 読み権限なしのフォルダ | サイドバーに非表示。アクセス不可のフォルダにファイルを移動する操作自体が不可能 |
| ファイルをフォルダ間移動 | 移動先フォルダの権限を自動適用。移動先が非表示なら移動操作自体が発生しない |

---

## 検証方法

1. マイグレーション: `docker compose up -d --build backend` → ログでカラム追加確認
2. グループAPI: curl で CRUD テスト
3. 権限チェック: admin ユーザーと一般ユーザーで同じドキュメントにアクセスし、権限差を確認
4. 検索フィルタ: others_read=false のドキュメントが非オーナー・非グループメンバーの検索結果に出ないことを確認
5. AIエージェント: 権限のない文書について質問し、「アクセス権限がありません」が返ることを確認
6. フロントエンド: 権限編集UI、グループ管理、一覧のパーミッション表示を目視確認
