# リファクタリング候補一覧

## 優先度: 高

### 1. FileExplorerPage.tsx の分割（2569行）
**場所**: `frontend/src/pages/FileExplorerPage.tsx`

1ファイルに全機能が集約されており、保守性が低い。以下のコンポーネント/フックに分割すべき:

- **`useDocumentList` カスタムフック** — ドキュメント取得・ページネーション・検索・フィルタリングのロジック（現在 `load()`, `loadMore()`, 検索連携等）
- **`useDocumentActions` カスタムフック** — CRUD操作（アップロード、削除、移動、リネーム、一括操作、ダウンロード）
- **`useFolderTree` カスタムフック** — フォルダツリー取得・操作・パンくず構築
- **`DocumentDetailModal`** — 詳細/編集モーダル（現在インライン定義、約400行）
- **`FolderSidebar`** — フォルダ/タグサイドバー（約200行）
- **`DocumentTable`** — テーブル表示部分（約300行）
- **`BulkActionBar`** — 一括操作ツールバー

### 2. documents.py の分割（900行超）
**場所**: `backend/app/routers/documents.py`

ルーターファイルにヘルパー関数・バックグラウンド処理・パーミッションチェックが混在。

- **`backend/app/services/documents.py`** — `_process_document_background()`, `_get_file_type()`, `_make_doc_list_item()`, `_load_tags_for_docs()` を移動
- **`backend/app/services/permissions.py`** — `_check_doc_access()`, `_check_folder_access()` を移動
- ルーターファイルはエンドポイント定義のみに

### 3. API レスポンス型の整理
**場所**: `backend/app/routers/documents.py`, `backend/app/routers/search.py`

Pydantic モデル（`DocumentListItem`, `DocumentDetail`, `FolderItem` 等）がルーターファイル内に定義されている。

- **`backend/app/schemas/documents.py`** に集約
- `search.py` と `documents.py` で重複する型定義を統一

---

## 優先度: 中

### 4. LLM サービスの抽象化
**場所**: `backend/app/services/llm.py`

OpenAI互換APIへの直接HTTP呼び出しがハードコードされている。

- プロバイダーインターフェースを定義し、将来的に複数LLMバックエンド対応を容易に
- リトライ・タイムアウト・エラーハンドリングの共通化

### 5. ai_agent.py のツール定義分離
**場所**: `backend/app/services/ai_agent.py`

ツール定義（JSON Schema）とツール実行ロジックが `run_agent()` 内にインライン定義。

- ツール定義を `backend/app/services/agent_tools.py` に分離
- 各ツールをクラスまたは関数として独立させる
- テスト容易性の向上

### 6. フロントエンド API 関数の整理
**場所**: `frontend/src/lib/api.ts`

全API呼び出しが1ファイルに集約（500行超）。

- `api/documents.ts` — ドキュメントCRUD
- `api/search.ts` — 検索関連
- `api/chat.ts` — チャット/ストリーミング
- `api/admin.ts` — 管理系（ユーザー、ロール、グループ、API キー）
- `api/client.ts` — 共通の `apiFetch` ヘルパー

### 7. コンテキストメニューのコンポーネント化
**場所**: `frontend/src/pages/FileExplorerPage.tsx` 内

右クリックメニューのロジックとUIがページコンポーネント内にインライン定義。

- `DocumentContextMenu` コンポーネントとして分離
- メニュー項目の定義を宣言的に

### 8. 検索キャッシュの統一
**場所**: `frontend/src/pages/FileExplorerPage.tsx`, `frontend/src/components/ChatPanel.tsx`

`sessionStorage` による独自キャッシュが複数箇所に散在。

- キャッシュ管理を `useSessionCache` フックに統一
- キーの命名規則を統一

### 9. エラーハンドリングの統一
**場所**: バックエンド全体

各ルーターで個別にHTTPException を投げているが、エラーレスポンスの形式が不統一。

- 共通のエラーレスポンススキーマを定義
- カスタム例外ハンドラーで統一的に処理

### 10. パーミッションチェックの依存性注入化
**場所**: `backend/app/routers/documents.py`

`_check_doc_access()`, `_check_folder_access()` が関数内で直接呼ばれている。

- FastAPI の `Depends()` パターンで依存性注入に変更
- ルート定義時点でパーミッション要件を明示

---

## 優先度: 低

### 11. CSS クラスの整理
**場所**: `frontend/src/pages/FileExplorerPage.tsx`

Tailwind クラスが非常に長い文字列になっている箇所が多数。

- `cn()` ユーティリティの活用
- 繰り返しパターンを `@apply` でカスタムクラス化

### 12. マジックナンバーの定数化
**場所**: 複数ファイル

- チャンクサイズ（`1000`, `200`）
- ページサイズ（`30`, `50`, `200`）
- タイムアウト値
- ファイルサイズ制限

→ `backend/app/constants.py`, `frontend/src/lib/constants.ts` に集約

### 13. テストの追加
**場所**: プロジェクト全体

現在テストがほぼ存在しない。優先的にテストすべき箇所:

- パーミッションチェックロジック
- 検索サービス（フィルタ組み合わせ）
- ドキュメント処理パイプライン
- API キー認証フロー

### 14. DB マイグレーションの整理
**場所**: `backend/alembic/versions/`

マイグレーションファイルが増加傾向。スキーマが安定したタイミングでスカッシュを検討。

### 15. 型安全性の強化
**場所**: フロントエンド全体

- `any` 型の使用箇所を削減
- API レスポンスの型ガード追加
- `zod` などによるランタイムバリデーション検討

### 16. ログの構造化
**場所**: バックエンド全体

現在 `logger.info()` / `logger.error()` で非構造化テキスト。

- 構造化ログ（JSON形式）への移行
- リクエストID のトレーシング

### 17. 設定管理の見直し
**場所**: `backend/app/config.py`

環境変数とDB設定（`SystemSetting`）が混在。

- どの設定がどこに保存されるかのドキュメント整理
- 起動時バリデーションの強化

### 18. フォルダ操作のバッチ化
**場所**: `backend/app/routers/documents.py`

フォルダ削除時に子ドキュメントを1件ずつ処理。大量データ時にN+1問題。

- バルクUPDATE/DELETE クエリに変更

### 19. ChatPanel のストリーミング状態管理
**場所**: `frontend/src/components/ChatPanel.tsx`

`useRef` と `useState` の混在で状態管理が複雑。

- `useReducer` パターンでストリーミング状態を一元管理
- `accumulated` 変数のクロージャ依存を解消
