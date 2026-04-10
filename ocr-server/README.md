# OCR Server

画像・PDFからテキストを抽出する軽量OCRサーバー。
[Surya OCR](https://github.com/VikParuchuri/surya) を使用し、GPU（ROCm/CUDA）で高速に推論する。

LAS（Local AI Search）のバックエンドから `POST /ocr` で呼び出される。

## アーキテクチャ

```
[LAS Backend / Queue Worker]
        │
        │  POST /ocr (multipart file)
        ▼
[OCR Server (host, port 8090)]
        │
        │  Surya OCR (DetectionPredictor + RecognitionPredictor)
        ▼
   { text, pages }
```

- ホスト上で直接実行（GPU アクセスのため Docker 外）
- バックエンドコンテナからは `http://host.docker.internal:8090` で接続
- 起動時にウォームアップ（ROCm カーネルのプリコンパイル）を実行

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
4. Surya の Detection → Recognition パイプラインでテキスト抽出
5. ページごとのテキストを結合して返却

## 依存関係

- Python 3.12+
- surya-ocr >= 0.17.0
- FastAPI + Uvicorn
- pypdfium2（PDF レンダリング）
- PyTorch（ROCm 7.2 または CUDA）

依存パッケージは `requirements.txt` を参照。

## セットアップ

```bash
cd ocr-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

PyTorch は ROCm/CUDA 対応版を別途インストールする必要がある。

## 起動方法

### 手動起動

```bash
./start.sh          # デフォルト: port 8090, GPU
./start.sh 9090     # ポート指定
TORCH_DEVICE=cpu ./start.sh   # CPU モード
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
- GPU 環境変数はサービスファイル内で設定済み

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TORCH_DEVICE` | `cuda` | 推論デバイス（`cuda` / `cpu`） |
| `RECOGNITION_BATCH_SIZE` | `64` | 認識バッチサイズ（固定でカーネル再コンパイルを防止） |
| `DETECTOR_BATCH_SIZE` | `8` | 検出バッチサイズ |
| `HSA_ENABLE_SDMA` | `0` | gfx1151 安定化（SDMA 無効） |
| `AMD_SERIALIZE_KERNEL` | `3` | gfx1151 安定化（カーネル直列化） |
| `ROCM_FORCE_DISABLE_LAZY_ALLOC` | `1` | gfx1151 安定化（遅延アロケーション無効） |
| `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL` | `1` | AOTriton 実験的機能有効化 |
| `OCR_SERVER_URL` | `http://host.docker.internal:8090` | バックエンド側の接続先設定（backend/.env） |

## 既知の問題

- **gfx1151 GPU カーネルクラッシュ**: `hipErrorLaunchFailure` が散発的に発生する。一度発生するとプロセスの GPU コンテキストが破損し、以降の OCR リクエストも全て 500 エラーになる。systemd の自動再起動で復旧する。
- ウォームアップは 10〜15 秒程度かかる。その間のリクエストは待機またはエラーになる。
