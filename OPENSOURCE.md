# オープンソース化計画

LAS（Local AI Search）を公開リポジトリとしてオープンソース化するための作業一覧。

## 1. 機密情報の除去（必須・公開前）

### 1.1 Sentry DSN のハードコード除去

Sentry DSN がソースコードに直書きされている。環境変数化する。

| ファイル | 行 | 内容 |
|---------|---|------|
| `backend/app/main.py` | 8 | `sentry_sdk.init("http://...@REDACTED_IP:8000/4")` |
| `ocr-server/server.py` | 9 | `sentry_sdk.init("http://...@REDACTED_IP:8000/4")` |

**対応**: `SENTRY_DSN` 環境変数がある場合のみ初期化するように変更。

```python
# Before
sentry_sdk.init("http://...@REDACTED_IP:8000/4")

# After
import os
dsn = os.environ.get("SENTRY_DSN")
if dsn:
    sentry_sdk.init(dsn)
```

### 1.2 ハードコードされたパスのプレースホルダー化

| ファイル | 内容 | 対応 |
|---------|------|------|
| `ocr-server/ocr-server.service` | `/home/user/...` がハードコード | パスをプレースホルダーに変更し、READMEで書き換え手順を記載 |
| `scripts/backup-s3.sh` | `PROJECT_DIR="/home/user/..."` | 同上 |
| `scripts/backup-s3.sh` | Wasabi エンドポイント・バケット名 | プレースホルダーに変更 |

### 1.3 .env ファイルの確認

現在 `.gitignore` で除外されており、git 履歴にも含まれていない（確認済み）。

| ファイル | 状態 |
|---------|------|
| `.env` | 追跡なし（`.gitignore`で除外） |
| `discord-las-bot/.env` | 追跡なし |
| `integration/notion/.env` | 追跡なし |

**対応**: 各サブディレクトリの `.gitignore` にも `.env` を追加して防御を強化。

### 1.4 .env.example の整備

| ファイル | 状態 |
|---------|------|
| `.env.example` | 存在する |
| `discord-las-bot/.env.example` | **存在しない — 作成必要** |
| `integration/notion/.env.example` | 存在する |
| `share-server/.env.example` | 存在する |

### 1.5 クレデンシャルのローテーション

公開前に以下を全て再発行する（ソースコードには含まれないが念のため）:

- [ ] Discord Bot トークン
- [ ] LAS API キー（全て）
- [ ] Notion API トークン
- [ ] Sentry DSN（公開後は新DSNを使用）
- [ ] JWT_SECRET / POSTGRES_PASSWORD

## 2. ドキュメント整備

### 2.1 完了済み

- [x] README.md（英語）
- [x] README_ja.md（日本語）
- [x] LICENSE（AGPL-3.0）
- [x] 依存ライブラリのライセンス一覧（README内）
- [x] ocr-server/README.md
- [x] 設計ドキュメント（docs/）

### 2.2 要作成

| ファイル | 内容 |
|---------|------|
| `CONTRIBUTING.md` | コントリビューションガイド（開発環境構築、PR規約、コーディング規約） |
| `SECURITY.md` | セキュリティ脆弱性の報告方法 |
| `CODE_OF_CONDUCT.md` | 行動規範（Contributor Covenant v2.1 推奨） |
| `.github/ISSUE_TEMPLATE/bug_report.md` | バグ報告テンプレート |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 機能リクエストテンプレート |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR テンプレート |

## 3. コード品質

### 3.1 CI/CD パイプライン

| ワークフロー | 内容 |
|------------|------|
| `ci.yml` | PR時にバックエンドテスト + フロントエンドビルド |
| `lint.yml` | ESLint（フロントエンド）+ Ruff/flake8（バックエンド） |

### 3.2 テスト

- [ ] 既存テストが CI で通ることを確認
- [ ] テスト実行手順を CONTRIBUTING.md に記載

### 3.3 TypeScript 型チェック

現在 `tsc` はエラーがある（Vite ビルドは通る）。公開前に修正するか、既知の問題として記録する。

## 4. リポジトリ整備

### 4.1 git 履歴のクリーンアップ（`git filter-repo`）

git 履歴に以下の機密情報が含まれていることを確認済み:

| 情報 | 深刻度 | 詳細 |
|------|--------|------|
| **Sentry DSN** | 高 | `REDACTED@REDACTED_IP`（Tailscale 内部IP + 認証トークン） |
| **Wasabi バケット名** | 中 | `s3://REDACTED_BUCKET`、Wasabi エンドポイント URL |

.env ファイル（実際のトークン・パスワード）は履歴に含まれていない（確認済み）。

**対応方針**: `git filter-repo` で該当文字列を履歴から完全に削除する。

```bash
# 1. git-filter-repo をインストール
pip install git-filter-repo

# 2. 置換ルールファイルを作成
cat > /tmp/replacements.txt << 'EOF'
REDACTED==>REDACTED_SENTRY_KEY
REDACTED_IP==>REDACTED_IP
REDACTED_BUCKET==>REDACTED_BUCKET
EOF

# 3. 履歴書き換え実行
git filter-repo --replace-text /tmp/replacements.txt

# 4. リモートを再設定して force push
git remote add origin <repository-url>
git push --force --all
git push --force --tags
```

**注意事項**:
- 全コミットハッシュが変わる（force push 必須）
- 他の開発者がいる場合は事前に通知し、クローンし直してもらう
- 公開前の今が最適なタイミング — 公開後に実施すると既にフォーク済みのリポジトリには反映されない
- 実行前にリポジトリのバックアップを取ること

```bash
# 書き換え後の最終確認
git log --all -p | grep -i "REDACTED\|100\.92\.140\.88\|REDACTED_BUCKET" | head -5
# → 何も出力されなければOK
```

### 4.2 .gitignore の強化

以下を追加:

- [ ] `discord-las-bot/.env`
- [ ] `integration/notion/.env`
- [ ] `integration/**/.env`
- [ ] `*.pem`, `*.key`（証明書ファイル）

### 4.3 不要ファイルの確認

- [ ] `docs/ai-file-organizer.md`（未追跡、必要か判断）
- [ ] `REFACTOR.md`（内部メモ、公開して問題ないか確認）

## 5. バージョン管理

### 5.1 方針

SemVer（`MAJOR.MINOR.PATCH`）を採用。`scripts/release.sh` でバージョン更新・コミット・タグ作成を一括実行する。

### 5.2 バージョン定義箇所

| ファイル | 形式 |
|---------|------|
| `frontend/package.json` | `"version": "x.y.z"`（source of truth） |
| `frontend/src/App.tsx` | `LAS Version x.y.z` |
| `backend/app/main.py` | `version="x.y.z"` |

### 5.3 リリース手順

```bash
# バージョンアップ（コミット + タグ自動作成）
./scripts/release.sh patch   # バグ修正: 0.9.0 → 0.9.1
./scripts/release.sh minor   # 新機能:   0.9.0 → 0.10.0
./scripts/release.sh major   # 破壊的変更: 0.9.0 → 1.0.0

# 確認（変更なし）
./scripts/release.sh patch --dry-run

# プッシュ
git push && git push --tags
```

### 5.4 完了済み

- [x] `scripts/release.sh` 作成
- [x] バージョンを `0.9.0` に統一（3箇所）
- [x] CLAUDE.md にバージョニングルール追記

## 6. 将来のロードマップ

[`FUTURE.md`](FUTURE.md) を参照。AI ファイル自動振分け、SMB対応、国際化（i18n）など。

## 7. 公開手順チェックリスト

公開当日に実施する作業:

### Phase 1: 機密情報対応
- [x] Sentry DSN を環境変数化（`backend/app/main.py`, `ocr-server/server.py`）
- [x] `ocr-server/ocr-server.service` のパスをプレースホルダー化
- [x] `scripts/backup-s3.sh` のパス・バケット名をプレースホルダー化
- [x] `discord-las-bot/.env.example` 作成
- [x] サブディレクトリの `.gitignore` 強化
- [ ] 全クレデンシャルをローテーション
- [ ] `git filter-repo` で履歴から Sentry DSN・Wasabi バケット名を削除（§4.1）
- [ ] 書き換え後の最終確認（grep で漏れがないことを検証）

### Phase 2: ドキュメント
- [x] CONTRIBUTING.md 作成
- [x] SECURITY.md 作成
- [x] CODE_OF_CONDUCT.md 作成
- [x] GitHub Issue / PR テンプレート作成

### Phase 3: コード品質
- [ ] GitHub Actions CI ワークフロー作成（公開後に実施。パブリックリポジトリなら無料）
- [x] テストが通ることを確認（パーミッションテスト39件 all passed）
- [x] TypeScript エラーの対応方針決定（エラー0件、解決済み）

### Phase 4: 公開
- [ ] git 履歴の最終確認（機密情報なし）
- [ ] GitHub リポジトリを Public に変更
- [ ] GitHub Topics 設定（`self-hosted`, `search`, `rag`, `ai`, `vector-search`, `document-management`）
- [ ] GitHub Description 設定
- [ ] リリースタグ作成（`v1.0.0`）

## 8. 優先順位

| 優先度 | タスク | 理由 |
|--------|--------|------|
| **P0** | 機密情報除去（§1） | 公開の絶対条件 |
| **P0** | git 履歴の書き換え（§4.1） | Sentry DSN・Wasabi バケット名が履歴に残っている |
| **P0** | クレデンシャルローテーション（§1.5） | 公開の絶対条件 |
| **P1** | CONTRIBUTING.md / SECURITY.md（§2.2） | コミュニティ参加に必要 |
| **P1** | CI/CD（§3.1） | PR 品質管理に必要 |
| **P2** | Issue / PR テンプレート（§2.2） | あると便利だが後からでも可 |
| **P2** | TypeScript 型チェック修正（§3.3） | 品質向上だが公開の必須条件ではない |
| **P3** | i18n（§5） | 大規模作業、公開後にマイルストーンとして進行 |
