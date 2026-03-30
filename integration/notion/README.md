# Notion → Local AI Search 同期

Notion のページツリーを再帰的に取得し、Markdown に変換して Local AI Search (LAS) に同期するスクリプト。

## 機能

- 5分間隔のポーリングで常時同期（間隔は設定可能）
- MD コンテンツの SHA-256 ハッシュで変更検知、差分があるページのみ送信
- 複数の Notion ワークスペース / トークンに対応
- 各トークンに対して複数の起点ページを指定可能
- 子ページを再帰的に全階層取得
- Notion ブロックを Markdown に変換（見出し、リスト、テーブル、コード、画像など）
- LAS の upsert 機能により、同じページは上書き更新（バージョン履歴あり）
- Notion のページ階層を LAS のフォルダ構造にマッピング
- SIGTERM/SIGINT でグレースフルシャットダウン

## セットアップ

### 1. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して以下を設定:

| 変数 | 説明 |
|------|------|
| `LAS_BASE_URL` | LAS の URL（例: `http://localhost:8000`） |
| `LAS_API_KEY` | LAS の API キー（`upload` 権限が必要） |
| `POLL_INTERVAL` | ポーリング間隔（秒、デフォルト: `300`） |
| `HASH_STORE_PATH` | ハッシュ保存先（デフォルト: `/data/hashes.json`） |
| `NOTION_SYNC_<N>_TOKEN` | Notion Integration Token |
| `NOTION_SYNC_<N>_PAGE_IDS` | 同期対象のページ ID（カンマ区切りで複数可） |
| `NOTION_SYNC_<N>_FOLDER` | LAS 上の保存先フォルダ（省略時: `Notion`） |

`<N>` は `1` から連番。複数ワークスペースを同期する場合は `2`, `3`, ... と追加。

### 2. Notion Integration の作成

1. https://www.notion.so/my-integrations で新しい Integration を作成
2. 「Read content」権限を付与
3. 同期したいページで「コネクト」から作成した Integration を追加
4. Token を `.env` の `NOTION_SYNC_<N>_TOKEN` に設定

### 3. ページ ID の取得

Notion でページを開き、URL からページ ID を取得:

```
https://www.notion.so/Your-Page-Title-{page_id}
                                        ^^^^^^^^ この部分
```

またはページメニューの「リンクをコピー」からも取得可能。

## 実行

### Docker で実行（推奨）

```bash
cd integration/notion
docker build -t notion-sync .

# 常駐プロセスとして起動（5分ごとにポーリング）
docker run -d \
  --name notion-sync \
  --env-file .env \
  --network host \
  -v notion-sync-data:/data \
  --restart unless-stopped \
  notion-sync
```

`-v notion-sync-data:/data` でハッシュストアを永続化。コンテナ再起動後も変更検知が継続される。

LAS が Docker Compose で動作している場合は、ネットワークを指定:

```bash
docker run -d \
  --name notion-sync \
  --env-file .env \
  --network local-ai-search_default \
  -v notion-sync-data:/data \
  --restart unless-stopped \
  notion-sync
```

この場合 `LAS_BASE_URL` は Docker 内のサービス名を使う（例: `http://backend:8000`）。

### 停止

```bash
docker stop notion-sync   # グレースフルシャットダウン（現在のサイクル完了後に停止）
```

### ログ確認

```bash
docker logs -f notion-sync
```

## フォルダ構造の例

起点ページ「Wiki」の下に「開発」→「API仕様」とネストしている場合:

```
LAS フォルダ:
  Notion/Workspace1/         <- 起点ページ "Wiki" の内容
  Notion/Workspace1/Wiki/    <- "Wiki" の子ページ
  Notion/Workspace1/Wiki/開発/  <- さらにその子ページ
```

## 対応ブロックタイプ

| Notion ブロック | Markdown 出力 |
|---------------|--------------|
| Paragraph | テキスト |
| Heading 1/2/3 | `#` / `##` / `###` |
| Bulleted list | `- item` |
| Numbered list | `1. item` |
| To-do | `- [x]` / `- [ ]` |
| Toggle | `<details>` |
| Code | コードブロック |
| Quote | `> text` |
| Callout | `> icon text` |
| Divider | `---` |
| Image | `![alt](url)` |
| Bookmark | `[title](url)` |
| Table | Markdown テーブル |
| Equation | `$$ expr $$` |
| Column layout | 内容をフラットに展開 |
