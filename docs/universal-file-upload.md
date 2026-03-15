# 汎用ファイルアップロード機能 設計書

## 概要

現在テキスト抽出可能なファイル（md, pdf, docx, xlsx, csv, html, pptx, 画像）のみアップロード可能だが、
オーディオ・ビデオ・3Dモデル・アーカイブ等あらゆるファイルをアップロードできるように拡張する。

テキスト抽出不可能なファイルは、ファイル名とユーザーが登録したメタ情報・テキスト情報で検索可能にする。

## ファイル分類

### Tier 1: テキスト抽出対応（現行）

自動的にテキスト抽出 → チャンク分割 → ベクトル化 → 要約生成を行う。

| ファイルタイプ | 拡張子 |
|------------|--------|
| Markdown/テキスト | .md, .txt, .markdown |
| PDF | .pdf |
| Word | .docx, .doc |
| Excel | .xlsx, .xls, .csv, .tsv |
| HTML | .html, .htm |
| PowerPoint | .pptx |
| 画像 (OCR) | .png, .jpg, .jpeg, .gif, .bmp, .tiff, .webp |

### Tier 2: プレビュー対応（新規）

テキスト抽出は行わない。ブラウザネイティブでプレビュー可能。

| ファイルタイプ | 拡張子 | プレビュー方式 |
|------------|--------|-------------|
| オーディオ | .mp3, .wav, .ogg, .m4a, .flac, .aac | `<audio>` タグ |
| ビデオ | .mp4, .webm, .mov, .avi, .mkv | `<video>` タグ |
| SVG | .svg | `<img>` またはインライン表示 |

### Tier 3: プレビュー不可（新規）

テキスト抽出もプレビューもできない。ファイル名 + ユーザー登録メタ情報で管理。

| ファイルタイプ | 拡張子例 |
|------------|---------|
| アーカイブ | .zip, .tar.gz, .7z, .rar |
| 3Dモデル | .obj, .fbx, .glb, .gltf |
| デザイン | .psd, .ai, .sketch, .fig |
| CAD | .dwg, .dxf, .step |
| 実行ファイル | .exe, .dmg, .AppImage |
| その他 | 未知の拡張子すべて |

## バックエンド変更

### 1. アップロード制限の撤廃

**ファイル**: `backend/app/routers/documents.py` (upload_document)
- ファイルタイプ判定: 既知の拡張子 → 対応タイプ、未知 → `"other"` として保存
- `_get_file_type()` → 未知の拡張子はそのまま拡張子を保存（例: `"mp4"`, `"zip"`）

**ファイル**: `backend/app/services/document_processing.py` (process_document_background)
- Tier 1 のファイルのみテキスト抽出・チャンク・ベクトル化・要約を実行
- Tier 2, 3 は `processing_status = "done"` で即完了（content は空文字列）

```python
EXTRACTABLE_TYPES = {"md", "pdf", "docx", "xlsx", "csv", "html", "pptx", "png", "jpg", "gif", "bmp", "tiff", "webp"}

async def process_document_background(doc_id, storage_path, file_type, filename):
    if file_type not in EXTRACTABLE_TYPES:
        # テキスト抽出スキップ — 即完了
        doc.processing_status = "done"
        await db.commit()
        return
    # 既存の処理...
```

### 2. メタ情報・テキスト情報の登録

既存の `memo` フィールドと `content` フィールド（OverType エディタで編集可能）をそのまま活用。

- **memo**: 短い説明（一覧に表示）
- **content**: 詳細なテキスト情報（OverType エディタで自由入力、検索・AI対象）

Tier 2, 3 のファイルでもユーザーが content を入力すれば、テキスト検索・AI検索の対象になる。
保存時に自動で再チャンク・再ベクトル化される（既に実装済み）。

### 3. 検索の調整

**ファイル**: `backend/app/services/search.py`
- fulltext_search: content が空のドキュメントは Chunk がないのでヒットしない（現行通り）
- vector_search: 同上
- title_search: ファイル名検索は全ファイル対象（現行通り）

→ **変更不要**。Tier 2, 3 はタイトル検索でヒットし、ユーザーが content を入力すれば全文検索でもヒットする。

### 4. AI ツールの調整

**ファイル**: `backend/app/services/agent_tools.py`

`read_document` ツール:
- content が空の場合、「このファイルはテキスト情報がありません。ファイル名: {title}, タイプ: {file_type}」を返す
- ユーザーが content を入力していればそれを返す（現行通り）

`grep` ツール:
- Chunk.content を検索するため、テキストなしのファイルは自動的にスキップ（現行通り、変更不要）

### 5. ウイルススキャン

#### ClamAV 導入

**docker-compose.yml に追加:**

```yaml
clamav:
  image: clamav/clamav:latest
  volumes:
    - clamav-data:/var/lib/clamav
  ports:
    - "3310:3310"
  restart: unless-stopped

volumes:
  clamav-data:
```

#### スキャンフロー

```
ファイルアップロード
  → ディスクに保存
  → ClamAV でスキャン (clamd ソケット経由)
  → 感染検出 → ファイル削除 + エラーレスポンス (422)
  → クリーン → DB登録 + バックグラウンド処理開始
```

#### 実装

**新規ファイル**: `backend/app/services/antivirus.py`

```python
import clamd

async def scan_file(file_path: str) -> tuple[bool, str]:
    """Scan a file with ClamAV.

    Returns (is_clean, message).
    """
    try:
        cd = clamd.ClamdNetworkSocket(host="clamav", port=3310, timeout=60)
        result = cd.scan(file_path)
        if result is None:
            return True, "OK"
        status, message = result[file_path]
        if status == "OK":
            return True, "OK"
        return False, message
    except clamd.ConnectionError:
        # ClamAV が起動していない場合はスキップ（ログ警告）
        logger.warning("ClamAV not available, skipping virus scan")
        return True, "Skipped (ClamAV unavailable)"
```

**依存追加**: `requirements.txt` に `pyclamd>=0.4.0`

#### DB変更

`Document` モデルに追加:

```python
scan_status: Mapped[str] = mapped_column(String(30), default="pending")
# "pending" | "clean" | "infected" | "skipped" | "error"
scan_result: Mapped[str | None] = mapped_column(Text, nullable=True)
```

#### 管理画面

- スキャン状態の表示（クリーン / 感染 / 未スキャン）
- 感染ファイルの一括削除
- 手動再スキャン機能

## フロントエンド変更

### 1. アップロードの拡張

**ファイル**: `frontend/src/components/BulkActionDialogs.tsx` (UploadDialog)
- `accept` 属性を削除（全ファイル受け入れ）

**ファイル**: `frontend/src/pages/FileExplorerPage.tsx`
- ドラッグ&ドロップのファイルフィルタリングを削除

### 2. プレビュー対応

**ファイル**: `frontend/src/components/DocumentPreview.tsx`

```typescript
// Tier 2: ブラウザネイティブプレビュー
if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(fileType)) {
  return <audio src={downloadUrl} controls className="w-full" />;
}
if (["mp4", "webm"].includes(fileType)) {
  return <video src={downloadUrl} controls className="w-full max-h-[60vh]" />;
}

// Tier 3: プレビュー不可
return (
  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
    <FileIcon className="h-16 w-16" />
    <p className="text-sm">このファイルのプレビューは利用できません</p>
    <p className="text-xs">{fileType.toUpperCase()} ファイル</p>
    <Button onClick={download}>ダウンロード</Button>
  </div>
);
```

### 3. メタ情報入力の案内

Tier 2, 3 のファイル詳細モーダルで:
- 「表示」タブ: プレビュー or 「プレビュー不可」表示
- 「テキスト編集」タブ: OverType エディタで自由にテキスト情報を入力可能。「このファイルのテキスト情報を入力すると検索・AIの対象になります」という案内表示
- 「編集」タブ: メモ・要約を入力可能

### 4. ファイルアイコンの拡張

ファイルタイプに応じたアイコン表示:
- オーディオ: 🎵 / Music アイコン
- ビデオ: 🎬 / Video アイコン
- アーカイブ: 📦 / Archive アイコン
- その他: 📄 / File アイコン

### 5. ウイルススキャン状態表示

- アップロード時: 「スキャン中...」→「クリーン」or「感染検出（アップロード拒否）」
- 一覧: 感染ファイルに警告バッジ（通常は表示されない。スキャン前にアップロード拒否するため）

## 実装順序

### Phase 1: 汎用アップロード（小〜中規模）
1. `_get_file_type()` の拡張 — 未知の拡張子をそのまま保存
2. `process_document_background` — 未対応ファイルのスキップ
3. フロントエンドのアップロード制限撤廃
4. プレビュー不可表示

### Phase 2: プレビュー拡張（小規模）
1. オーディオ/ビデオプレビュー
2. ファイルアイコンの拡張

### Phase 3: ウイルススキャン（大規模）
1. ClamAV Docker コンテナ追加
2. `antivirus.py` サービス実装
3. アップロードフローにスキャン統合
4. DB マイグレーション（scan_status, scan_result）
5. 管理画面にスキャン状態表示

## セキュリティ考慮事項

- **ファイルサイズ制限**: 現行の制限を維持（設定で変更可能に）
- **ストレージ管理**: 大きなファイル（ビデオ等）のディスク使用量に注意
- **実行ファイルの取り扱い**: アップロード可能だがサーバー上で実行されることはない（静的ファイルとして保存のみ）
- **ウイルススキャン**: ClamAV が利用不可の場合はスキップ（ログ警告）
- **MIME タイプ検証**: Content-Type ヘッダーだけでなく、マジックバイトでの検証を検討
