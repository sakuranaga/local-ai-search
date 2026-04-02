# チャット履歴永続化 設計書

## 背景

現状、AIチャットの会話は `sessionStorage` に1件のみ保存されており、ブラウザを閉じると消失する。
検索履歴（サイドバー）がそのまま会話履歴として機能するように、会話をDB永続化する。

## 要件

- バックエンドDBにユーザーごとに保存
- 検索クエリ = 会話のキー（1クエリ = 1会話）
- 同一クエリで再検索した場合、過去の会話を読み込んで続きから
- 検索履歴削除時に会話履歴も連動削除
- 保存タイミング: 検索時、ストリーミング終了後、ユーザー入力時、AI返答後（ループ）

## テーブル設計

```sql
-- 検索ごとの会話セッション（1クエリ = 1会話）
CREATE TABLE chat_conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query       TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT now(),
    updated_at  TIMESTAMP DEFAULT now(),
    UNIQUE(user_id, query)
);

-- 会話内の各メッセージ
CREATE TABLE chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,          -- "user" | "assistant"
    content         TEXT NOT NULL,
    turn_context    TEXT,                   -- ツール使用結果の要約（assistantのみ）
    sources         JSONB,                 -- [{document_id, title, chunk_id}]
    tool_steps      JSONB,                 -- [{round, name, query, summary}]
    created_at      TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_chat_conversations_user_query ON chat_conversations(user_id, query);
CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
```

## API設計

| メソッド | エンドポイント | 用途 |
|---|---|---|
| GET | `/chat/conversations?query=...` | クエリで会話を検索（復元用） |
| POST | `/chat/messages` | メッセージ追加（ユーザー入力 or AI回答） |
| DELETE | `/chat/conversations?query=...` | 検索履歴削除時に連動削除 |

### GET /chat/conversations?query=...

レスポンス:
```json
{
  "id": "uuid",
  "query": "検索クエリ",
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "content": "質問テキスト",
      "turn_context": null,
      "sources": null,
      "tool_steps": null,
      "created_at": "2026-03-31T..."
    },
    {
      "id": "uuid",
      "role": "assistant",
      "content": "回答テキスト",
      "turn_context": "search(\"...\")...",
      "sources": [{"document_id": "...", "title": "..."}],
      "tool_steps": [{"round": 1, "name": "search", "query": "...", "summary": "..."}],
      "created_at": "2026-03-31T..."
    }
  ],
  "created_at": "2026-03-31T...",
  "updated_at": "2026-03-31T..."
}
```

会話が存在しない場合は `null` を返す。

### POST /chat/messages

リクエスト:
```json
{
  "query": "検索クエリ",
  "role": "user",
  "content": "メッセージ内容",
  "turn_context": null,
  "sources": null,
  "tool_steps": null
}
```

会話が存在しなければ自動作成（upsert）。

### DELETE /chat/conversations?query=...

検索履歴削除時に呼び出し。会話とメッセージをCASCADE削除。

## フロントエンドの流れ

1. **検索実行** → `GET /chat/conversations?query=xxx` で既存会話を検索
   - あり → メッセージを復元してチャットパネルに表示
   - なし → 新規会話作成、AIに質問開始
2. **ユーザー入力** → `POST /chat/messages` で保存
3. **AI回答完了（ストリーミング終了後）** → `POST /chat/messages` で保存（turn_context, sources, tool_steps含む）
4. **検索履歴削除** → `DELETE /chat/conversations?query=xxx` で会話も連動削除

## 移行

- `sessionStorage` のチャットキャッシュ（`las_chat_cache`）は廃止
- 検索履歴は引き続き `localStorage` で管理（既存のまま）
- 検索履歴の削除操作にDELETE API呼び出しを追加

## ファイル変更予定

### バックエンド
- `app/models.py` — ChatConversation, ChatMessage モデル追加
- `alembic/versions/xxx_add_chat_history.py` — マイグレーション
- `app/routers/chat.py` — API エンドポイント追加

### フロントエンド
- `src/components/ChatPanel.tsx` — sessionStorage → API呼び出しに変更
- `src/lib/api/index.ts` or `src/lib/api/search.ts` — API関数追加
- `src/lib/api/types.ts` — 型定義追加
- `src/pages/FileExplorerPage.tsx` — 検索履歴削除時にDELETE API呼び出し追加
