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

### Phase 1: tus アップロード基盤 + 汎用ファイル対応
1. tusd Docker コンテナ追加 + nginx プロキシ設定
2. tus-hook エンドポイント実装（pre-create 認証 + post-finish 処理）
3. tus-js-client 導入、`uploadWithProgress` を tus ベースに置き換え
4. 進捗率トースト表示
5. `_get_file_type()` の拡張 — 未知の拡張子をそのまま保存
6. `process_document_background` — 未対応ファイルのスキップ
7. フロントエンドのアップロード制限撤廃（accept 属性削除）
8. ファイルサイズ制限の SystemSetting 追加
9. プレビュー不可ファイルの表示対応

### Phase 2: プレビュー拡張（小規模）
1. オーディオ/ビデオプレビュー (`<audio>`, `<video>` タグ)
2. ファイルタイプ別アイコンの拡張

### Phase 3: ウイルススキャン（中規模）
1. ClamAV Docker コンテナ追加
2. `antivirus.py` サービス実装
3. tusd pre-finish hook でスキャン統合
4. DB マイグレーション（scan_status, scan_result）
5. 管理画面にスキャン状態表示

## tus レジューマブルアップロード

### 概要

現行の `fetch` ベースのアップロードをtusプロトコルに置き換える。
tusはHTTPベースのレジューマブルアップロードプロトコルで、中断しても途中から再開可能。
ブラウザを閉じて再度開いても、未完了のアップロードを自動再開できる。

### アーキテクチャ

```
ブラウザ (tus-js-client)
  ↓ tus プロトコル (チャンク転送、レジューム可能)
nginx (/tusd/ → tusd:8080)
  ↓ プロキシ
tusd コンテナ (Go製公式サーバー)
  ↓ 完了時 HTTP hook
FastAPI backend (/api/ingest/tus-hook)
  ↓ DB登録 + バックグラウンド処理開始
```

### tusd Docker コンテナ

**docker-compose.yml に追加:**

```yaml
tusd:
  image: tusproject/tusd:latest
  restart: unless-stopped
  command:
    - -hooks-http=http://backend:8000/api/ingest/tus-hook
    - -hooks-enabled-events=post-finish
    - -upload-dir=/data/uploads/tus
    - -behind-proxy
    - -base-path=/tusd/
  volumes:
    - ./data/uploads/tus:/data/uploads/tus
  depends_on:
    - backend
```

**nginx.conf に追加:**

```nginx
# tus アップロードプロキシ
location /tusd/ {
    proxy_pass http://tusd:8080;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;

    # tus に必要なヘッダーを通す
    proxy_set_header Upload-Length     $http_upload_length;
    proxy_set_header Upload-Offset    $http_upload_offset;
    proxy_set_header Tus-Resumable    $http_tus_resumable;
    proxy_set_header Upload-Metadata  $http_upload_metadata;

    # 大きなファイル対応
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

### バックエンド: tus-hook 受け口

**ファイル**: `backend/app/routers/ingest.py` に追加

tusd がアップロード完了時に POST する webhook。ファイル情報を受け取り、
Document レコードを作成してバックグラウンド処理を開始する。

```python
@router.post("/tus-hook")
async def tus_hook(
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """tusd post-finish hook: ファイルアップロード完了時に呼ばれる."""
    body = await request.json()
    event_type = body.get("Type", "")

    if event_type != "post-finish":
        return {"ok": True}

    upload = body.get("Event", {}).get("Upload", {})
    file_path = upload.get("Storage", {}).get("Path", "")
    metadata = upload.get("MetaData", {})

    # metadata から情報を取得 (tus-js-client の metadata で送る)
    filename = base64_decode(metadata.get("filename", ""))
    filetype = base64_decode(metadata.get("filetype", ""))
    folder_id = base64_decode(metadata.get("folder_id", ""))
    user_id = base64_decode(metadata.get("user_id", ""))

    # Document レコード作成
    file_type = get_file_type(filename)
    doc = Document(
        title=filename,
        source_path=file_path,
        file_type=file_type,
        content="",
        owner_id=uuid.UUID(user_id),
        created_by_id=uuid.UUID(user_id),
        updated_by_id=uuid.UUID(user_id),
        processing_status="pending",
        folder_id=uuid.UUID(folder_id) if folder_id else None,
    )
    db.add(doc)
    await db.flush()

    # File レコード
    file_record = File(
        document_id=doc.id,
        filename=filename,
        storage_path=file_path,
        file_size=upload.get("Size", 0),
        mime_type=filetype,
    )
    db.add(file_record)
    await db.commit()

    # バックグラウンド処理開始
    background_tasks.add_task(
        process_document_background, doc.id, file_path, file_type, filename
    )

    return {"ok": True, "document_id": str(doc.id)}
```

### フロントエンド: tus-js-client

**インストール**: `npm install tus-js-client`

**ファイル**: `frontend/src/lib/fileExplorerHelpers.ts` (uploadWithProgress を置き換え)

```typescript
import * as tus from "tus-js-client";

export function uploadWithProgress(
  file: File,
  onUploaded: () => void,
  folderId?: string | null,
  userId?: string,
): void {
  const toastId = toast.loading(`${file.name}: アップロード準備中...`);

  const upload = new tus.Upload(file, {
    endpoint: "/tusd/",
    retryDelays: [0, 1000, 3000, 5000],
    chunkSize: 5 * 1024 * 1024, // 5MB チャンク
    metadata: {
      filename: file.name,
      filetype: file.type,
      folder_id: folderId || "",
      user_id: userId || "",
    },
    onProgress: (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      toast.loading(`${file.name}: アップロード中... ${pct}%`, { id: toastId });
    },
    onSuccess: () => {
      toast.loading(`${file.name}: 処理中...`, { id: toastId });
      onUploaded();
      // バックグラウンド処理のポーリングは tus-hook で Document 作成後に開始
      // Document ID は tus-hook のレスポンスから取得できないため、
      // タイトルで検索してポーリングする or SSE で通知する
      pollProcessingByTitle(file.name, toastId, onUploaded);
    },
    onError: (error) => {
      toast.error(`${file.name}: アップロード失敗 - ${error.message}`, { id: toastId });
    },
  });

  // 中断したアップロードがあれば再開を試みる
  upload.findPreviousUploads().then((previousUploads) => {
    if (previousUploads.length > 0) {
      upload.resumeFromPreviousUpload(previousUploads[0]);
    }
    upload.start();
  });
}
```

### アップロードフロー

```
1. ユーザーがファイルを選択/ドロップ
2. tus-js-client がチャンクに分割して tusd にアップロード開始
3. トーストに進捗率表示: "ファイル名: アップロード中... 45%"
4. ブラウザを閉じても tusd 側にチャンクが残る
5. 再度開くと tus-js-client が自動的に未完了アップロードを検出・再開
6. 転送完了 → tusd が post-finish hook で FastAPI に通知
7. FastAPI が Document 作成 + バックグラウンド処理開始
8. トーストが処理ステータスに切り替わり:
   "ファイル名: テキスト抽出中..."
   "ファイル名: ベクトル化中..."
   "ファイル名: 処理完了 ✓"
```

### 認証の考慮

tusd はデフォルトで認証なし。対策:

1. **nginx で認証ヘッダーを検証**: tusd への proxy で Authorization ヘッダーをチェック
2. **tusd の pre-create hook**: アップロード開始前に FastAPI で認証チェック
3. **metadata に user_id を含める**: post-finish hook で user_id を使ってドキュメントの所有者を設定

推奨: pre-create hook で JWT トークンまたは API キーを検証。
全アップロード（ブラウザUI + API外部連携）を tus 経由に統一する。

```yaml
# tusd コマンドに追加
command:
  - -hooks-http=http://backend:8000/api/ingest/tus-hook
  - -hooks-enabled-events=pre-create,post-finish
```

```python
# pre-create hook で認証チェック（JWT or APIキー）
if event_type == "pre-create":
    token = metadata.get("token", "")
    api_key = metadata.get("api_key", "")

    if token:
        user = verify_jwt(base64_decode(token))
        if not user:
            return JSONResponse(status_code=401, content={"error": "Unauthorized"})
    elif api_key:
        user, key_obj = await verify_api_key(base64_decode(api_key), db)
        if not user:
            return JSONResponse(status_code=401, content={"error": "Invalid API key"})
        # APIキーのfolder_id制限チェック
        requested_folder = metadata.get("folder_id", "")
        if key_obj.folder_id and requested_folder != str(key_obj.folder_id):
            return JSONResponse(status_code=403, content={"error": "API key restricted to specific folder"})
        # APIキーの権限チェック（upload権限が必要）
        if "upload" not in key_obj.permissions:
            return JSONResponse(status_code=403, content={"error": "API key lacks upload permission"})
    else:
        return JSONResponse(status_code=401, content={"error": "Authentication required"})
    return {"ok": True}
```

### APIキー外部連携での利用

tus プロトコルは HTTP ベースのため、curl や各言語のtusクライアントライブラリから利用可能。
既存の `/api/ingest/upload`（APIキー用）も tus に統合し、全アップロードを1つの経路に統一する。

```bash
# 例: curl でAPIキーを使ったtusアップロード
# 1. アップロード開始
curl -X POST https://example.com/tusd/ \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: 12345" \
  -H "Upload-Metadata: filename $(echo -n 'report.pdf' | base64),api_key $(echo -n 'las_xxxx' | base64),folder_id $(echo -n 'uuid-here' | base64)"

# 2. チャンク送信（レスポンスのLocationヘッダーのURLに対して）
curl -X PATCH https://example.com/tusd/<upload-id> \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @report.pdf
```

Python (tuspy) での例:

```python
from tusclient import client

tus = client.TusClient("https://example.com/tusd/")
uploader = tus.uploader(
    "report.pdf",
    metadata={"filename": "report.pdf", "api_key": "las_xxxx", "folder_id": "uuid-here"},
    chunk_size=5*1024*1024,
)
uploader.upload()
```

## ファイルサイズ制限

### 設計

管理画面の SystemSetting でファイルサイズ上限を設定可能にする。

| 設定キー | デフォルト値 | 説明 |
|---------|------------|------|
| `upload_max_size_mb` | 500 | 1ファイルあたりの最大サイズ (MB) |

### バックエンド実装

tusd の pre-create hook でサイズチェック:

```python
if event_type == "pre-create":
    upload_length = upload.get("Size", 0)
    max_size = int(await get_setting(db, "upload_max_size_mb") or "500") * 1024 * 1024
    if upload_length > max_size:
        return JSONResponse(
            status_code=413,
            content={"error": f"ファイルサイズが上限を超えています"}
        )
```

### フロントエンド

- アップロードダイアログにサイズ上限を表示
- tus-js-client の `onBeforeRequest` でクライアント側事前チェック
- ドラッグ&ドロップ時にもサイズ確認

### nginx

tusプロキシに `client_max_body_size 0` を設定（チャンク転送のため無制限）。
従来の `/api/` エンドポイントの制限は現行の `50m` を維持。

## アップロード進捗表示

### トースト表示フロー

```
ファイル名: アップロード中... 45%     ← tus 転送段階（進捗率）
ファイル名: テキスト抽出中...         ← バックグラウンド処理段階（ステータス）
ファイル名: ベクトル化中...
ファイル名: 処理完了 ✓
```

大きなファイル（ビデオ等）では転送段階の進捗率が特に重要。
tus-js-client の `onProgress` コールバックでリアルタイムに更新。

### 中断・再開時の表示

```
ファイル名: アップロード中断（再開可能）   ← ブラウザ閉じた/ネットワーク切断
ファイル名: アップロード再開中... 67%      ← 再度開いた時に自動再開
```

## セキュリティ考慮事項

- **ファイルサイズ制限**: SystemSetting で設定可能（デフォルト 100MB）
- **ストレージ管理**: 大きなファイル（ビデオ等）のディスク使用量に注意
- **実行ファイルの取り扱い**: アップロード可能だがサーバー上で実行されることはない（静的ファイルとして保存のみ）
- **ウイルススキャン**: ClamAV が利用不可の場合はスキップ（ログ警告）
- **MIME タイプ検証**: Content-Type ヘッダーだけでなく、マジックバイトでの検証を検討
