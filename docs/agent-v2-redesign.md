# AIエージェント v2 設計書

## 概要

AIエージェントのコアループ（`ai_agent.py`）を書き直し、以下の4機能を統合する:

1. **意図分類の改善** — `search`/`context`/`direct` の3段階分類
2. **会話圧縮（Compaction）** — 古いメッセージの構造化サマリー圧縮
3. **スキルシステム** — ドメイン固有の解釈ルール自動注入
4. **ワーキングメモリ** — セッション内で取得した情報の追跡

検索エンジン(`search.py`)、ツール定義・実行(`agent_tools.py`)、LLM API(`llm.py`)、
フロントエンド、DBモデルは**原則そのまま**維持する。

---

## 1. 意図分類の改善

### 現状の問題

- `search` / `direct` の2択では「既存コンテキストで回答可能」を判定できない
- 「要約をして」「なぜ見つからなかった？」等がsearchに分類される
- turn_context（前回のツール使用履歴）が分類に反映されない

### 新しい分類

```
search  — 新たな文書検索が必要（情報を調べる、文書を探す、比較する等）
context — 既に会話内にある情報で回答可能（要約、分析、前の回答への深掘り等）
direct  — 検索も既存情報も不要（雑談、時刻、挨拶、操作方法、メタ質問等）
```

### 分類プロンプト

```python
_INTENT_SYSTEM_PROMPT = """\
ユーザーの最新の質問を、会話の文脈を考慮して分類してください。

分類:
- search: 新たな社内文書の検索が必要（まだ調べていない情報を探す）
- context: 会話中に既にある情報で回答可能（要約、分析、言い換え、前の回答への深掘り）
- direct: 検索も既存情報も不要（雑談、時刻の質問、挨拶、操作方法、会話自体への感想）

「search」「context」「direct」のいずれかのみを出力してください。"""
```

### 分類コンテキストの改善

現状は直近6メッセージのcontent（200文字切り捨て）のみ。改善点:

```python
# turn_contextも含めて分類精度を上げる
for m in recent:
    role = m.get("role", "")
    content = m.get("content", "")[:200]
    turn_ctx = m.get("turn_context", "")[:100]  # ツール使用履歴も含める
    if turn_ctx:
        context_msgs.append(f"{role}: {content}\n[ツール使用: {turn_ctx}]")
    else:
        context_msgs.append(f"{role}: {content}")
```

### 検索フォーム由来の強制search

検索フォームからの入力は、ユーザーが明示的に検索を意図している。
この場合、意図分類をスキップして `intent="search"` 固定にする。

**API変更:**

```python
class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: list[ContextChunk] = []
    force_search: bool = False  # 検索フォーム由来: True
```

**フロントエンド:**

```typescript
// ChatPanel.tsx — initialQuery（検索フォーム由来）の場合
body: JSON.stringify({
    messages: chatMessages,
    context: currentContext,
    force_search: isInitialQuery,  // 最初の検索フォーム入力時のみtrue
})
```

**エージェント側:**

```python
async def run_agent(
    db, messages, existing_context=None,
    user=None, cancel_event=None,
    force_search: bool = False,  # 追加
):
    if force_search:
        intent = "search"
    else:
        intent = await _classify_intent(messages, cancel_event=cancel_event)
```

フォローアップ（チャット欄からの入力）は `force_search=False` なので意図分類が働く。
AIが「検索が必要」と判断すれば自動で `search` に分類されるため、
ユーザーが「検索してください」と明示する必要はない。
`force_search` はあくまで検索フォーム由来の初回メッセージに対する保証であり、
フォローアップの検索能力を制限するものではない。

例:
- 「登記簿も確認して」→ AIが `search` と判定 → 自動で文書検索
- 「さっきの文書を要約して」→ AIが `context` と判定 → 既存情報で回答
- 「ありがとう」→ AIが `direct` と判定 → 雑談回答

### 分類結果に応じたフロー

| 分類 | ツール提供 | 回答方式 | トリガー |
|------|-----------|---------|---------|
| `search` | あり | エージェントループ | 検索フォーム or 意図分類 |
| `context` | なし | ストリーミング直接回答（会話コンテキスト付き） | 意図分類のみ |
| `direct` | なし | ストリーミング直接回答（軽量） | 意図分類のみ |

`context`と`direct`の違い: `context`は会話履歴（turn_context含む）をフルに渡す。
`direct`はシステムプロンプト+直近メッセージのみ（軽量）。

---

## 2. 会話圧縮（Compaction）

### 既存設計書からの変更

`docs/agent-conversation-compaction.md` の設計をベースに、エージェントv2に統合する。

### パラメータ

```python
COMPACT_CONFIG = {
    "preserve_recent_pairs": 2,       # 直近2往復は原文保持
    "max_estimated_tokens": 8000,     # これを超えたら圧縮発動
    "char_per_token": 2,              # 日本語: 1トークン≒2文字
}
```

### 圧縮タイミング

`run_agent()` 内で、conv_messages構築直後・意図分類前に実行:

```python
conv_messages = build_conv_messages(system_content, messages)

# 圧縮判定
if should_compact(conv_messages):
    logger.info("Compacting: %d messages", len(conv_messages))
    conv_messages = compact_messages(conv_messages)
    logger.info("After compaction: %d messages", len(conv_messages))

# 意図分類
intent = await _classify_intent(messages, cancel_event=cancel_event)
```

### 圧縮サマリー構造

```
<compact_summary>
## 会話サマリー（圧縮済み）
メッセージ数: ユーザー5件、アシスタント5件

### ユーザーのリクエスト
1. [2026-04-03 14:30] SMtokyoのサーバーについて教えて
2. [2026-04-03 14:35] 登記簿の住所はどうなっている？

### 参照した文書
- smtokyo鯖.md (ID: 24fd7719...)
- 登記 DDR8 20251222.pdf (ID: 22f86ea6...)

### 使用したツール
- search: 3回、read_document: 4回

### 得られた主要な情報
- SMtokyoのサーバーはさくらインターネット東新宿に配置
- DDR8の登記上の本店は長野県軽井沢町

### 直前の回答要旨
DDR8の見積書は足場材レンタル管理システムの開発見積もりで...
</compact_summary>
```

### ルールベース生成

LLM呼び出し不要。メッセージのパターンマッチで抽出:

- `role == "user"` → リクエスト一覧
- `turn_context` → ツール使用回数、参照文書
- `role == "assistant"` の `[回答]` 部分 → 回答要旨
- `created_at` → 期間

### DB永続化

```python
class ChatConversation(Base):
    ...
    compact_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
```

次回の会話復元時、フロントエンドが全メッセージを送る代わりに:
- compact_summary + 直近メッセージのみを送信
- バックエンド側でcompact_summaryをsystemメッセージとして注入

**注**: これはオプション。まずはインメモリ圧縮（LLM呼び出し前に毎回判定）で開始し、
DB永続化は後から追加可能。

---

## 3. スキルシステム

### 既存設計書からの変更

`docs/agent-skill-system.md` の設計をベースに、自動検出方式で統合。

### スキルファイル

```
backend/app/skills/
  legal.md       — 登記簿、定款、契約書の読み方
  finance.md     — 見積書、請求書、決算書の構造
  technical.md   — サーバー、API、インフラ用語
  construction.md — 足場、工事用語
  general.md     — 汎用（要約、比較、一覧）
```

フォーマット:

```markdown
---
name: legal
description: 登記簿、定款、契約書などの法的文書の解釈ルール
tags: [登記, 定款, 契約, 法人, 登記簿, 履歴事項]
---

## 登記簿（履歴事項全部証明書）の読み方
- 「会社法人等番号」は法人の一意識別子
- 複数の住所変更がある場合、最も日付が新しい記録が現在の本店所在地
- 「令和X年Y月Z日移転」の記載は移転登記日であり、実際の移転日と異なる場合がある
...
```

### 自動検出ロジック

```python
async def detect_skills(user_query: str, turn_contexts: list[str]) -> list[str]:
    """ユーザーのクエリとturn_contextからスキルタグをマッチング"""
    all_text = user_query + " ".join(turn_contexts)
    matched = []
    for skill in _loaded_skills:
        for tag in skill.tags:
            if tag in all_text:
                matched.append(skill.name)
                break
    return matched
```

### 注入タイミング

意図分類後、エージェントループ前:

```python
intent = await _classify_intent(...)

# スキル検出・注入
if intent in ("search", "context"):
    skill_names = await detect_skills(user_query, turn_contexts)
    if skill_names:
        skill_content = load_skills(skill_names)
        system_content += f"\n\n## 適用スキル\n{skill_content}"
```

### ツール（オプション）

`load_skill` ツールは初期実装では**不要**。自動検出で十分。
将来LLMが「このスキルが必要」と判断できるようになったら追加。

---

## 4. ワーキングメモリ

### 概念

エージェントが「今のセッションで何を知っているか」を追跡する軽量な仕組み。
turn_contextのセッション版。

### 構造

```python
@dataclass
class WorkingMemory:
    """セッション内のワーキングメモリ"""
    searched_queries: list[str] = field(default_factory=list)
    read_documents: list[dict] = field(default_factory=list)  # {id, title, summary}
    key_facts: list[str] = field(default_factory=list)          # 重要な事実

    def to_prompt_section(self) -> str:
        """システムプロンプトに注入する文字列"""
        lines = ["## ワーキングメモリ（今回のセッションで取得済みの情報）"]
        if self.searched_queries:
            lines.append(f"検索済みクエリ: {', '.join(self.searched_queries[-5:])}")
        if self.read_documents:
            lines.append("読み込み済み文書:")
            for doc in self.read_documents[-10:]:
                lines.append(f"  - {doc['title']} (ID: {doc['id']})")
                if doc.get('summary'):
                    lines.append(f"    要旨: {doc['summary'][:100]}")
        if self.key_facts:
            lines.append("取得済みの主要情報:")
            for fact in self.key_facts[-5:]:
                lines.append(f"  - {fact}")
        return "\n".join(lines)
```

### 更新タイミング

ツール実行後にワーキングメモリを更新:

```python
for tc in tool_calls:
    result_text, sources = await execute_tool(...)

    # ワーキングメモリ更新
    if tool_name == "search":
        working_memory.searched_queries.append(tool_args.get("query", ""))
    elif tool_name == "read_document":
        working_memory.read_documents.append({
            "id": tool_args.get("id"),
            "title": ...,
            "summary": result_text[:150],
        })
```

### 意図分類への活用

ワーキングメモリの内容を意図分類に渡すことで、
「既に読んだ文書について質問している」→ `context` の判定精度が上がる:

```python
# 分類コンテキストにワーキングメモリを追加
if working_memory.read_documents:
    docs_str = ", ".join(d["title"] for d in working_memory.read_documents[-5:])
    context_msgs.append(f"[読み込み済み文書: {docs_str}]")
```

### セッション範囲

ワーキングメモリは `run_agent()` の1回の呼び出し内（= 1ターン）で生成される。
ただし、前ターンの `turn_context` がワーキングメモリの「初期状態」として機能する。

マルチターンでは:
- turn_context → 前ターンのワーキングメモリのサマリー（DB保存済み）
- WorkingMemory → 現ターンで新たに取得した情報

---

## 5. 新しいエージェントループ

### フロー図

```
[ユーザーメッセージ]
        |
        v
[conv_messages 構築]
        |
        v
[会話圧縮（should_compact → compact_messages）]
        |
        v
[意図分類（search / context / direct）]
        |
        ├── direct ──→ [ストリーミング直接回答] ──→ [done]
        |
        ├── context ──→ [ストリーミング直接回答（会話コンテキスト付き）] ──→ [done]
        |
        └── search ──→ [スキル検出・注入]
                            |
                            v
                       [エージェントループ]
                            |
                       ┌────┴────┐
                       | Round N |
                       └────┬────┘
                            |
                   ┌────────┴────────┐
                   | LLM呼び出し     |
                   | (with tools)    |
                   └────────┬────────┘
                            |
                   ┌────────┴────────┐
                   |tool_calls あり?  |
                   └───┬─────────┬───┘
                      Yes       No
                       |         |
                  [ツール実行]    |
                  [メモリ更新]    |
                  [次ラウンドへ]   |
                                 |
                      ┌──────────┴──────────┐
                      | Round 1 かつ         |
                      | LLM判断を尊重?       |
                      └──────┬───────────┬──┘
                            Yes          No
                             |            |
                     [最終回答ストリーミング] |
                                          |
                              [クエリ再構築して検索]
                              （LLMに検索クエリを
                               生成させる）
                                          |
                                     [次ラウンドへ]
```

### 強制検索の廃止 → クエリ再構築

現状の「ユーザーの生メッセージをそのまま検索」を廃止。
代わりに、LLMがツールを使わなかった場合:

```python
if round_num == 1 and not tool_calls and intent == "search":
    # LLMに検索クエリを考えさせる
    conv_messages.append({
        "role": "user",
        "content": "ユーザーの質問に答えるために、searchツールで検索してください。"
                   "適切な検索クエリを考えて検索を実行してください。",
    })
    continue  # 次のラウンドでLLMがツールを使うはず
```

これにより:
- LLMが検索クエリを自分で考える（ユーザーの生メッセージより精度が高い）
- LLMが「検索不要」と判断した場合を尊重できる
- 強制検索のハックが不要になる

---

## 6. 実装ファイル一覧

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `backend/app/services/ai_agent.py` | **書き直し** | 新エージェントループ、意図分類改善、ワーキングメモリ |
| `backend/app/services/compaction.py` | **新規** | 会話圧縮エンジン |
| `backend/app/services/skills.py` | **新規** | スキル読み込み・検出 |
| `backend/app/skills/*.md` | **新規** | スキルファイル群 |
| `backend/app/services/agent_tools.py` | 微修正 | SYSTEM_PROMPT調整（ワーキングメモリ対応） |
| `backend/app/models.py` | 微修正 | ChatConversation.compact_summary追加 |
| `frontend/src/components/ChatPanel.tsx` | 微修正 | intent SSEイベント表示（任意） |

### 軽微な変更

- `backend/app/routers/chat.py` — ChatRequestに `force_search` フィールド追加、run_agentに伝達
- `frontend/src/components/ChatPanel.tsx` — initialQuery時に `force_search: true` を送信
- `frontend/src/lib/api/search.ts` — streamChat()に `forceSearch` パラメータ追加

### 変更しないファイル

- `backend/app/services/llm.py` — LLM API呼び出しはそのまま
- `backend/app/services/search.py` — 検索エンジンはそのまま

---

## 7. 実装順序

### Phase 1: エージェントループ書き直し + 意図分類改善
- `ai_agent.py` の `run_agent()` を新設計で書き直し
- 3段階意図分類（search/context/direct）
- 強制検索廃止 → クエリ再構築方式
- ワーキングメモリ（基本版）

### Phase 2: 会話圧縮
- `compaction.py` 新規作成
- `ai_agent.py` に圧縮判定・実行を統合
- テスト（長い会話でのコンテキスト溢れ解消確認）

### Phase 3: スキルシステム
- `skills.py` 新規作成
- `backend/app/skills/` にスキルファイル作成（legal, finance, technical）
- `ai_agent.py` にスキル検出・注入を統合
- テスト（登記簿の正しい解釈確認）

### Phase 4: DB永続化（オプション）
- ChatConversation.compact_summary カラム追加
- マイグレーション
- フロントエンドでの圧縮サマリー表示（任意）

---

## 8. テストシナリオ

### 意図分類

| 入力 | 期待分類 | 理由 |
|------|---------|------|
| 「DDR8の住所を教えて」 | search | 新規情報検索 |
| 「その文書を要約して」 | context | 直前で読んだ文書 |
| 「なぜ見つからなかった？」 | context/direct | 会話自体への質問 |
| 「今何時？」 | direct | 一般的な質問 |
| 「登記簿も確認して」 | search | 追加検索 |
| 「ありがとう」 | direct | 挨拶 |

### 会話圧縮

1. 10往復以上の会話を作成
2. 圧縮が発動することを確認
3. 圧縮後も文脈が保持されることを確認（前の質問を参照できる）
4. LLM APIエラー（400）が発生しないことを確認

### スキル

1. 「DDR8の登記簿を見て」→ legalスキル自動検出
2. 登記簿の住所変更を正しく時系列で解釈
3. 「見積書の金額を教えて」→ financeスキル自動検出
4. 見積書の構造（品名、数量、単価、合計）を正しく読み取り

### ワーキングメモリ

1. 検索→文書読込後、「さっき読んだ文書の要約をして」
2. intent=context で検索せずに回答できることを確認
3. 「他に関連文書はない？」→ intent=search で追加検索

---

## 9. 設定値

```python
# ai_agent.py
AGENT_CONFIG = {
    "max_rounds": 10,                    # エージェントループ最大ラウンド
    "intent_classification": True,        # 意図分類の有効/無効
}

# compaction.py
COMPACT_CONFIG = {
    "preserve_recent_pairs": 2,           # 直近2往復は保持
    "max_estimated_tokens": 8000,         # 圧縮閾値
    "char_per_token": 2,                  # 日本語トークン推定
}

# skills.py
SKILL_CONFIG = {
    "auto_detect": True,                  # 自動検出の有効/無効
    "max_skills_per_turn": 2,             # 1ターンに注入するスキル上限
    "skills_dir": "app/skills/",          # スキルファイルディレクトリ
}
```
