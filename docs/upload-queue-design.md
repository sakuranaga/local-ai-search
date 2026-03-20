# アップロードキュー 詳細設計

## 目的

現在のアップロード処理は、選択/ドロップされた全ファイルを即座に tus アップロード開始する。
少数ファイルでは問題ないが、フォルダアップロード（数百〜数万件）では以下の問題が起きる:

- ブラウザの同時接続上限（~6）に依存した不安定な並行制御
- ファイルごとの個別トーストで画面が埋まる
- 全ファイルの tus.Upload インスタンスを同時生成しメモリ圧迫
- 処理ステータスの個別ポーリングでサーバーに大量リクエスト

キューマネージャーを導入し、**通常のファイルアップロードとフォルダアップロードの両方**で使用する。

---

## アーキテクチャ概要

```
FileExplorerPage
  │
  ├─ ドロップ / ファイル選択 / フォルダ選択
  │     │
  │     ▼
  │  重複チェック (checkDuplicates)
  │     │
  │     ▼
  │  UploadQueueManager.enqueue(files)
  │     │
  │     ├─ キュー追加 → state 更新 → UI 反映
  │     │
  │     └─ ワーカーループ (同時 MAX_CONCURRENT 件)
  │           │
  │           ├─ tus アップロード (既存ロジック流用)
  │           ├─ 完了 → 次のキューアイテム開始
  │           ├─ エラー → スキップして次へ
  │           └─ 中止 → 全アクティブ abort + キュークリア
  │
  └─ UploadProgressPanel (トースト置き換え)
       ├─ 全体プログレスバー (完了数/総数, 転送済み/総サイズ)
       ├─ アクティブアップロード一覧 (ファイル名 + 個別%)
       ├─ 処理中ファイル一覧 (ステータスラベル)
       └─ 一括中止ボタン
```

---

## 1. UploadQueueManager

### 設計方針

- **React 外のクラス**として実装（`frontend/src/lib/uploadQueue.ts`）
- 状態変更は **コールバック** で通知 → React 側で `useSyncExternalStore` または `useState` + `subscribe` で購読
- `tus-js-client` の Upload インスタンスはキューから取り出したタイミングで生成（メモリ節約）
- 既存の `uploadWithProgress()` は内部的にこのクラスに置き換える（後方互換ラッパーを残す）

### インターフェース

```typescript
// frontend/src/lib/uploadQueue.ts

export interface QueueItem {
  id: string;                    // crypto.randomUUID()
  file: File;
  folderId: string | null;
  status: "queued" | "uploading" | "processing" | "done" | "error" | "cancelled";
  progress: number;              // 0-100 (アップロード%)
  processingStatus?: string;     // "scanning" | "parsing" | ... (バックエンド処理)
  error?: string;
  bytesUploaded: number;
  bytesTotal: number;
}

export interface QueueState {
  items: QueueItem[];
  activeCount: number;           // 現在アップロード中の件数
  totalBytes: number;            // 全体のバイト数
  uploadedBytes: number;         // アップロード済みバイト数
  completedCount: number;        // done の件数
  errorCount: number;            // error の件数
  isRunning: boolean;            // キューが動作中か
}

export type QueueListener = (state: QueueState) => void;

export class UploadQueueManager {
  private queue: QueueItem[] = [];
  private activeUploads: Map<string, tus.Upload> = new Map();
  private listeners: Set<QueueListener> = new Set();
  private maxConcurrent = 3;
  private aborted = false;

  /** キューにファイルを追加 */
  enqueue(files: File[], folderId?: string | null): void;

  /** 全体を中止（アクティブ abort + キュークリア） */
  abort(): void;

  /** 特定アイテムをキャンセル（未開始のみ） */
  cancel(itemId: string): void;

  /** 完了・エラー分をクリア（UIリセット） */
  clear(): void;

  /** 状態購読 */
  subscribe(listener: QueueListener): () => void;

  /** 現在の状態を取得 */
  getState(): QueueState;
}
```

### 処理フロー

```
enqueue(files)
  │
  ├─ 各ファイルを QueueItem 化 (status: "queued")
  ├─ this.queue に追加
  ├─ notify() で全リスナーに通知
  └─ _processNext() を呼び出し
        │
        ├─ activeCount >= maxConcurrent → return (待機)
        ├─ queue から "queued" を1件取り出し
        ├─ status = "uploading"
        ├─ tus.Upload インスタンス生成（この時点で初めて生成）
        │     ├─ onProgress → item.progress 更新 → notify()
        │     ├─ onSuccess  → item.status = "processing"
        │     │                → _pollStatus(item) 開始
        │     │                → _processNext() (次を開始)
        │     └─ onError    → item.status = "error", item.error = msg
        │                    → _processNext()
        └─ activeUploads に登録
```

### メモリ管理

- `File` オブジェクトはキューに保持するが、アップロード完了後に `item.file = null as any` で参照を切る
- `tus.Upload` インスタンスは完了/エラー後に `activeUploads.delete(id)` で即破棄
- `clear()` 呼び出しで完了済みアイテムをキューから削除

### 同時アップロード数

```
const MAX_CONCURRENT = 3;
```

3 件を選択した理由:
- tus の 5MB チャンク × 3 = 常時 15MB のバッファ（メモリ許容範囲）
- ブラウザの同時接続上限（6）の半分を使用し、API コール用に余裕を残す
- バックエンドの GPU セマフォ（2）を考慮し、処理パイプラインを詰まらせない

---

## 2. 処理ステータスのポーリング最適化

### 現状の問題

現在 `_pollProcessingByTitle()` は:
1. ファイル名で `getDocuments({q: filename})` を最大10回ポーリングして docId を特定
2. `getProcessingStatus(docId)` を最大300回（5分）1秒間隔でポーリング

大量ファイルで全件にこれをやるとサーバー負荷が爆発する。

### 改善: バッチポーリング

```typescript
// UploadQueueManager 内部

private processingItems: Map<string, string> = new Map(); // itemId → docId
private pollingTimer: number | null = null;

_startPolling() {
  if (this.pollingTimer) return;
  this.pollingTimer = window.setInterval(() => this._pollBatch(), 2000);
}

_stopPolling() {
  if (this.pollingTimer) {
    clearInterval(this.pollingTimer);
    this.pollingTimer = null;
  }
}

async _pollBatch() {
  const processing = this.queue.filter(i => i.status === "processing");
  if (processing.length === 0) {
    this._stopPolling();
    return;
  }

  // docId が未確定のものは検索で特定
  for (const item of processing) {
    if (!this.processingItems.has(item.id)) {
      // 1回だけ検索を試みる（失敗したら次のポーリングで再試行）
      try {
        const data = await getDocuments({ q: item.file.name, per_page: 1 });
        if (data.items.length > 0) {
          this.processingItems.set(item.id, data.items[0].id);
        }
      } catch { /* next cycle */ }
    }
  }

  // docId が確定済みのものをバッチでステータス取得
  const docIds = [...this.processingItems.entries()]
    .filter(([itemId]) => processing.some(i => i.id === itemId));

  // 個別に getProcessingStatus を呼ぶ（バッチ API は将来検討）
  // ただし間隔が2秒なので、同時処理中が最大3件なら問題ない
  for (const [itemId, docId] of docIds) {
    try {
      const s = await getProcessingStatus(docId);
      const item = this.queue.find(i => i.id === itemId);
      if (!item) continue;
      item.processingStatus = s;
      if (s === "done") {
        item.status = "done";
        this.processingItems.delete(itemId);
      } else if (s === "error") {
        item.status = "error";
        item.error = "処理エラー";
        this.processingItems.delete(itemId);
      }
    } catch { /* ignore */ }
  }

  this.notify();
}
```

**ポイント**:
- ポーリング間隔を 1秒 → 2秒に（十分なレスポンス）
- 同時に "processing" 状態のアイテムは最大 `MAX_CONCURRENT` 件 + α なので、リクエスト数は制御可能
- 将来的にバッチステータス API (`POST /api/documents/status/batch`) を追加すれば 1 リクエストに統合可能

---

## 3. UploadProgressPanel（UI コンポーネント）

### 表示位置

画面右下に固定表示（トーストの代わり）。最小化可能。

```
frontend/src/components/UploadProgressPanel.tsx
```

### レイアウト

```
┌─────────────────────────────────────────────────┐
│ アップロード  12 / 150 件完了   [_] [×]          │
│ ████████████████░░░░░░░░░░  3.2 GB / 15 GB      │
├─────────────────────────────────────────────────┤
│ ▶ A社見積書.pdf               アップロード中 45% │
│ ▶ B社提案書.pptx              アップロード中 12% │
│ ▶ 議事録_Q3.md                アップロード中 89% │
│ ○ 設計メモ.md                 ベクトル化中...     │
│ ○ 契約書.pdf                  ウイルススキャン中.. │
├─────────────────────────────────────────────────┤
│ エラー: 2 件  [詳細]              [一括中止]     │
└─────────────────────────────────────────────────┘
```

### 状態遷移

```
非表示 ─── enqueue() ──→ 展開表示
展開表示 ── [_] ────────→ 最小化（バーのみ）
最小化 ──── クリック ───→ 展開表示
展開表示 ── 全完了 ─────→ 3秒後に自動非表示（エラーありの場合は残る）
展開表示 ── [×] ────────→ 非表示（clear() 呼び出し、未完了があれば確認ダイアログ）
```

### 最小化時

```
┌─────────────────────────────────────────┐
│ ↑ 12/150 件  ████████░░ 3.2/15GB       │
└─────────────────────────────────────────┘
```

### 少数ファイル（1〜2件）の場合

従来通りトースト表示のほうが自然。閾値を設ける:

```
ファイル数 <= 2  → 従来のトースト（uploadWithProgress 互換）
ファイル数 >= 3  → UploadProgressPanel
```

### コンポーネント設計

```typescript
// frontend/src/components/UploadProgressPanel.tsx

interface Props {
  state: QueueState;
  onAbort: () => void;
  onClear: () => void;
}

export function UploadProgressPanel({ state, onAbort, onClear }: Props) {
  const [minimized, setMinimized] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  // 全完了時の自動非表示
  useEffect(() => {
    if (state.completedCount + state.errorCount === state.items.length
        && state.items.length > 0 && state.errorCount === 0) {
      const t = setTimeout(onClear, 3000);
      return () => clearTimeout(t);
    }
  }, [state, onClear]);

  // ...render
}
```

---

## 4. 既存コードとの統合

### uploadWithProgress() の扱い

**残す（後方互換ラッパー）**。少数ファイル（1〜2件）では従来のトースト動作を維持する。

```typescript
// fileExplorerHelpers.ts（変更後）

export function uploadWithProgress(
  file: File,
  onUploaded: () => void,
  folderId?: string | null,
): () => void {
  // 従来通りトーストベースの単一ファイルアップロード
  // 内部実装は変更なし
}
```

### startUploadWithCheck() の変更

```typescript
// FileExplorerPage.tsx

async function startUploadWithCheck(files: File[]) {
  const dupTitles = await checkDuplicates(files.map(f => f.name));
  const dupSet = new Set(dupTitles);
  const dups: File[] = [];
  const nonDups: File[] = [];
  for (const f of files) {
    if (dupSet.has(f.name)) dups.push(f);
    else nonDups.push(f);
  }

  if (nonDups.length <= 2 && dups.length === 0) {
    // 少数: 従来のトースト
    const reload = () => { load(true); loadFolders(); };
    for (const f of nonDups) {
      uploadWithProgress(f, reload, uploadFolderId);
    }
  } else {
    // 3件以上: キューマネージャー
    queueManager.enqueue(nonDups, uploadFolderId);
  }

  if (dups.length > 0) {
    setOverwriteQueue(dups);
  }
}
```

### 重複確認後の統合

`handleOverwriteConfirm` / `handleOverwriteAll` も同様に、件数に応じてキューに投入:

```typescript
function handleOverwriteAll() {
  if (overwriteQueue.length <= 2) {
    const reload = () => { load(true); loadFolders(); };
    for (const file of overwriteQueue) {
      uploadWithProgress(file, reload, uploadFolderId);
    }
  } else {
    queueManager.enqueue(overwriteQueue, uploadFolderId);
  }
  setOverwriteQueue([]);
}
```

### リスト再読み込みのタイミング

現在は各ファイルの `onUploaded` で `load(true)` を呼んでいる（大量ファイルで N 回リロード）。

キューマネージャー使用時:
- アップロード完了ごとではなく、**キュー全体完了時** に 1 回だけ `load(true)` を実行
- **5件完了ごと** にも中間リロード（ユーザーが途中経過を見られるように）

```typescript
// UploadQueueManager
private completedSinceLastReload = 0;
private onBatchReload?: () => void;

_onItemComplete() {
  this.completedSinceLastReload++;
  if (this.completedSinceLastReload >= 5) {
    this.completedSinceLastReload = 0;
    this.onBatchReload?.();
  }
}

_onQueueDrain() {
  this.onBatchReload?.();
  this.completedSinceLastReload = 0;
}
```

---

## 5. 重複チェックの最適化

### 現状の問題

`checkDuplicates()` は全ファイル名を一括で POST する。数万件のファイル名を1リクエストで送ると:
- リクエストボディが巨大（ファイル名 × 数万）
- バックエンドの IN 句が膨大

### 改善

バッチ分割（500件ずつ）:

```typescript
async function checkDuplicatesBatched(titles: string[]): Promise<Set<string>> {
  const BATCH_SIZE = 500;
  const allDups = new Set<string>();
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const dups = await checkDuplicates(batch);
    for (const d of dups) allDups.add(d);
  }
  return allDups;
}
```

---

## 6. 一括中止の実装

```typescript
// UploadQueueManager

abort() {
  this.aborted = true;

  // アクティブなアップロードを全て abort
  for (const [id, upload] of this.activeUploads) {
    upload.abort(true).catch(() => {});
    const item = this.queue.find(i => i.id === id);
    if (item) {
      item.status = "cancelled";
      trackUploadEnd(item.file.name);
    }
  }
  this.activeUploads.clear();

  // キュー待ちを全てキャンセル
  for (const item of this.queue) {
    if (item.status === "queued") {
      item.status = "cancelled";
    }
  }

  // ポーリング停止
  this._stopPolling();
  this.notify();
}
```

---

## 7. localStorage 永続化（中断回復）

### 現状

`las_active_uploads` に `{filename, startedAt}` を保存。ページリロード時に未完了を検出。

### キューマネージャーでの変更

キュー全体の状態は保存しない（File オブジェクトはシリアライズ不可）。
代わりに、**アクティブなアップロードのみ** 従来通り `trackUploadStart` / `trackUploadEnd` で追跡する。

ページリロード時:
- 中断されたアップロードは tus の resume 機能で再開可能
- キューに残っていた未開始ファイルは失われる（再ドロップが必要）
- 処理中（processing）のファイルはバックエンドが独立して完了するので問題なし

---

## 8. エラーハンドリング

### エラー種別と対応

| エラー | 対応 |
|--------|------|
| tus アップロード失敗（ネットワーク） | tus 内蔵リトライ (0, 1s, 3s, 5s) → 全失敗で error 表示、次のファイルへ |
| tus resume 失敗 | fingerprint クリア → 新規アップロードで自動リトライ（既存ロジック） |
| ウイルス検出 | processing → error（バックエンドが処理）、ポーリングで検出 |
| 処理タイムアウト（5分） | processing → error 表示 |
| 認証エラー (401) | 全体中止、ログイン画面へリダイレクト |

### エラー詳細表示

パネル下部の「エラー: N件 [詳細]」クリックで展開:

```
┌─────────────────────────────────────────────┐
│ エラー詳細                                    │
│ × virus_sample.exe  ウイルスが検出されました   │
│ × broken.pdf        アップロード失敗 - timeout │
│                                    [閉じる]  │
└─────────────────────────────────────────────┘
```

---

## 9. ファイル構成

```
frontend/src/lib/uploadQueue.ts          ← UploadQueueManager クラス
frontend/src/components/UploadProgressPanel.tsx  ← 進捗パネル UI
frontend/src/lib/fileExplorerHelpers.ts  ← uploadWithProgress() は残す（1-2件用）
frontend/src/pages/FileExplorerPage.tsx  ← startUploadWithCheck 変更、パネル配置
```

### 変更するファイル

| ファイル | 変更内容 |
|----------|----------|
| `uploadQueue.ts` | **新規**: キューマネージャー |
| `UploadProgressPanel.tsx` | **新規**: 進捗パネル |
| `fileExplorerHelpers.ts` | 軽微: `trackUploadStart/End` を export（既に export 済み） |
| `FileExplorerPage.tsx` | `startUploadWithCheck` 修正、パネル配置、キュー購読 |

### バックエンド変更

今回のキューイング機能では **バックエンド変更なし**。
将来的な最適化候補:
- `POST /api/documents/status/batch` — 複数 docId のステータス一括取得
- `POST /api/documents/check-duplicates` の IN 句上限チェック追加

---

## 10. 実装順序

1. `UploadQueueManager` クラス実装 + 単体テスト
2. `UploadProgressPanel` コンポーネント実装
3. `FileExplorerPage` へのキュー統合（3件以上でパネル表示）
4. 重複チェックのバッチ分割
5. 動作確認・調整

キューが安定したら、次のフォルダアップロード機能でそのまま使用する。
