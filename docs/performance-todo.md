# パフォーマンス改善 TODO

2026-03-20 時点の診断結果に基づく改善項目。

---

## 対応済み

| 項目 | 対応日 |
|------|--------|
| DB インデックス追加 (documents.updated_at, created_at, created_by_id) | 2026-03-20 |
| DB インデックス追加 (document_tags.tag_id) | 2026-03-20 |
| DB インデックス追加 (user_favorites.document_id) | 2026-03-20 |

---

## フロントエンド

### 高 — FileExplorerPage コンポーネント分割

**現状**: `FileExplorerPage.tsx` が 1,926 行の巨大コンポーネント。状態変更（お気に入りトグル等）で全体が再レンダーされる。

**改善案**:
- テーブル行を `React.memo` 付きの独立コンポーネントに分離
- サイドバーを独立コンポーネントに分離
- ヘッダー（フィルタ・ソート）を独立コンポーネントに分離
- `favoriteIds` を Context または Zustand 等の状態管理に移行し、必要なコンポーネントだけが再レンダーされるようにする

**影響**: 30件のリスト表示で、お気に入り1件トグルするだけで全行が再レンダーされている。

### 高 — テーブル行のインライン関数排除

**現状**: `items.map()` 内で `onClick`, `onDoubleClick`, `onContextMenu`, `onTouchStart` に毎レンダーで新しい関数を生成。

**改善案**:
- イベントハンドラを `useCallback` で安定化
- 行コンポーネントを `React.memo` でラップ
- `data-*` 属性 + 単一のハンドラで委譲（Event Delegation）する方法も検討

### 中 — サイドバーコンポーネントのメモ化

**現状**: `FolderTreeItem`, `SidebarTagItem`, `DropTarget` に `React.memo` なし。親の再レンダーで全て再レンダーされる。

**改善案**: 各コンポーネントを `React.memo` でラップ。

### 中 — バンドルサイズ削減

**現状**: JS 1.1MB (gzip 320KB)、コード分割なし。

**改善案**:
- `React.lazy` + `Suspense` でページ単位のコード分割（AdminPage, LoginPage 等）
- Lucide アイコンのツリーシェイキング確認
- `vite` の `manualChunks` で vendor 分離

### 低 — 大量データ時のリスト仮想化

**現状**: ページネーション（30件/ページ）で問題は顕在化していない。

**改善案**: 将来的に無限スクロールで数百件表示する場合は `react-window` や `@tanstack/virtual` を導入。

### 低 — IntersectionObserver の再生成

**現状**: `load` 関数の依存が12個あり、変更のたびに IntersectionObserver が再生成される。

**改善案**: `load` を ref で保持し、Observer の依存から外す。

---

## バックエンド

### 中 — count クエリの最適化

**現状**: ページネーション用の count クエリが、本体クエリの全 JOIN をそのまま含む subquery をカウントしている。

**改善案**: count 用のクエリから不要な JOIN（chunk_count, file_size, share_count の outerjoin）を除外する。基本の WHERE 条件だけでカウントすれば十分。

### 中 — お気に入りサブクエリの簡略化

**現状**: `select(UserFavorite.document_id).where(...).subquery()` を `select()` で再ラップしている。

**改善案**: `.in_(select(UserFavorite.document_id).where(...))` に直接渡す（中間 `.subquery()` 不要）。

### 低 — 初期ロード API 統合

**現状**: フロントエンド初期ロードで 6 本の API を並列呼び出し（folders, tags, trash, favorites, filter-options, share-enabled）。

**改善案**: `/api/init` のような統合エンドポイントで 1 リクエストにまとめる。ただし現状並列呼び出しで体感速度は問題ない。

### 低 — date_to フィルタの堅牢化

**現状**: `date_to + "T23:59:59.999999"` という文字列連結で上限を作成。

**改善案**: `datetime.fromisoformat(date_to) + timedelta(days=1)` で翌日 0:00 未満にする。
