# OCR Server

画像・PDFからテキストを抽出する軽量OCRサーバー。
[Surya OCR](https://github.com/VikParuchuri/surya) v2 を使用する。推論は Surya が子プロセスとして起動する `llama-server`（llama.cpp）で行い、GPU（Vulkan/CUDA/Metal）で高速に処理する。

LAS（Local AI Search）のバックエンドから `POST /ocr` で呼び出される。

## アーキテクチャ

```
[LAS Backend / Queue Worker]
        │
        │  POST /ocr (multipart file)
        ▼
[OCR Server (host, port 8090)]
        │
        │  Surya v2 RecognitionPredictor
        ▼
[llama-server (子プロセス, 127.0.0.1, 空きポート)]
        │  surya-2.gguf + surya-2-mmproj.gguf
        ▼
   { text, pages }
```

- ホスト上で直接実行（GPU アクセスのため Docker 外）
- バックエンドコンテナからは `http://host.docker.internal:8090` で接続
- 起動時に llama-server を立ち上げ、準備完了まで待つ（数秒）
- torch は CPU のみで使用（GPU は llama-server 側が使う）

## API

### `POST /ocr`

画像または PDF ファイルを受け取り、OCR テキストを返す。

**Request**: `multipart/form-data`
- `file`: 画像（PNG, JPG, GIF, BMP, TIFF, WEBP）または PDF

**Response**:
```json
{
  "text": "抽出されたテキスト...",
  "pages": 1
}
```

### `GET /health`

ヘルスチェック。

```json
{
  "status": "ok",
  "model_loaded": true
}
```

## 処理の流れ

1. ファイルを受信（画像 or PDF）
2. PDF の場合は 300 DPI でページごとに画像化（pypdfium2）
3. 画像の最大サイズを 4000px に制限（LANCZOS リサンプリング）
4. Surya v2（VLM）でページ全体を認識し、ブロックを読み順に並べてテキスト化
5. ページごとのテキストを結合して返却

## 依存関係

- Python 3.12+
- surya-ocr >= 0.20.0
- FastAPI + Uvicorn
- pypdfium2（PDF レンダリング）
- GPU 対応ビルドの `llama-server`（[llama.cpp](https://github.com/ggml-org/llama.cpp)）

依存パッケージは `requirements.txt` を参照。

## セットアップ

```bash
cd ocr-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

モデル（`datalab-to/surya-ocr-2-gguf`）は初回起動時に Hugging Face から自動ダウンロードされる。

## 起動方法

### 手動起動

```bash
./start.sh          # デフォルト: port 8090
./start.sh 9090     # ポート指定
LLAMA_CPP_BINARY=/path/to/llama-server ./start.sh   # llama-server が PATH にない場合
```

### systemd サービス（推奨）

クラッシュ時に自動再起動される。

```bash
# サービスを登録（初回のみ）
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/ocr-server.service" ~/.config/systemd/user/ocr-server.service
systemctl --user daemon-reload
systemctl --user enable ocr-server

# 操作
systemctl --user start ocr-server     # 起動
systemctl --user stop ocr-server      # 停止
systemctl --user restart ocr-server   # 再起動
systemctl --user status ocr-server    # 状態確認

# ログ
journalctl --user -u ocr-server -f          # リアルタイム
journalctl --user -u ocr-server --since today  # 今日のログ
```

サービス設定（`ocr-server.service`）:
- `Restart=on-failure` — クラッシュ時に 5 秒後に自動再起動
- `WantedBy=default.target` — ユーザーログイン時に自動起動
- `TimeoutStartSec=660` — モデル初回ダウンロードを考慮した起動待ち時間

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TORCH_DEVICE` | `cpu` | torch の実行デバイス（v2 では GPU 不要） |
| `SURYA_INFERENCE_BACKEND` | `llamacpp` | 推論バックエンド（`llamacpp` / `vllm`） |
| `LLAMA_CPP_BINARY` | `llama-server` | llama-server のパス（PATH にない場合に指定） |
| `SURYA_INFERENCE_PARALLEL` | `8` | llama-server の並列スロット数 |
| `OCR_SERVER_URL` | `http://host.docker.internal:8090` | バックエンド側の接続先設定（backend/.env） |

## 既知の問題

- **gfx1151（Radeon 8060S）で ROCm 版 torch が動かない**: カーネル 6.17 系では、GPU カーネルの初回起動時に `GCVM_L2_PROTECTION_FAULT` が出て処理が止まる。v2 では torch を CPU で使い、GPU 推論は Vulkan 版 llama-server に任せることで回避している。
