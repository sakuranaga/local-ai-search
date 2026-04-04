# AIエージェント 会話圧縮（Compaction）

## 背景と問題

LASのチャットは検索クエリ単位で会話が永続化されており、ユーザーは同じトピックについて
何度もフォローアップの質問ができる。しかし、会話が長くなるとLLMのコンテキストウィンドウを
圧迫し、以下の問題が発生する:

1. **LLM APIエラー (400)**: コンテキスト超過でリクエストが拒否される
   - 実際に発生済み。llama-serverの `-c` を32768→131072に増やして対処したが根本解決ではない
2. **応答品質の低下**: コンテキストが長すぎるとLLMの注意力が分散し、回答精度が落ちる
3. **レイテンシ増加**: トークン数に比例してLLMの処理時間が増加する
4. **コスト増加**: 将来クラウドLLMを使う場合、トークン課金が膨大になる

### 参考: Claude Code / claw-code の実装

claw-codeでは `compact.rs` に会話圧縮が実装されている:

- `preserve_recent_messages: 4` — 直近4メッセージは保持
- `max_estimated_tokens: 10,000` — 超えたら圧縮発動
- トークン推定: `len() / 4 + 1` のヒューリスティック
- 圧縮サマリーの構造:
  - メッセージ数（user/assistant/tool別）
  - 使用したツール一覧
  - 直近のユーザーリクエスト（最大3つ、160文字）
  - 未完了タスク
  - 参照したファイル一覧
  - 現在の作業内容
  - タイムライン（各メッセージの要約）
- 再圧縮時: 前回のサマリーを「Previously compacted context」として保持し、
  新しい内容を「Newly compacted context」として追加

---

## 現状の実装

### 会話メッセージの構築 (`ai_agent.py`)

```python
conv_messages = [{"role": "system", "content": system_content}]

for m in messages:
    if m.get("turn_context") and m.get("role") == "assistant":
        augmented = (
            f"[前回のツール使用結果]\n{m['turn_context']}\n\n"
            f"[回答]\n{m['content']}"
        )
        conv_messages.append({"role": "assistant", "content": augmented})
    else:
        conv_messages.append({"role": m["role"], "content": m["content"]})
```

- **全メッセージをそのまま送信**: DBから復元した全会話履歴がLLMに渡される
- **圧縮機能なし**: メッセージ数やトークン数の制限なし
- **turn_contextの展開**: assistantメッセージにツール使用結果を付加するため、さらにトークンが膨張

### コンテキスト超過の既存対策

- llama-serverの `-c` を131072に設定（`--parallel 4` で1スロット32768トークン）
- `turn_context` のサマリーを1500文字に制限
- これ以外の対策なし

### LLM API呼び出し (`llm.py`)

```python
payload = {
    "model": model,
    "messages": messages,  # 全メッセージがそのまま渡される
    "max_tokens": 2048,
    ...
}
```

---

## 設計

### 圧縮の方針

claw-codeのアプローチを採用しつつ、LAS固有の要素（文書検索の文脈）を加味する。

**基本方針:**
- 直近Nメッセージ（ユーザー+アシスタントのペア）は原文保持
- それより古いメッセージは構造化サマリーに圧縮
- 圧縮はLLM呼び出し前に毎回判定
- 圧縮サマリーはDBに永続化（会話復元時にも使える）

### トリガー条件

```python
COMPACT_CONFIG = {
    "preserve_recent_pairs": 2,       # 直近2往復（4メッセージ）は保持
    "max_estimated_tokens": 8000,     # 圧縮可能メッセージの推定トークン数がこれを超えたら発動
    "char_per_token": 2,              # 日本語は1トークン≒2文字（英語の4文字より短い）
}
```

日本語はトークン効率が英語より低いため、`char_per_token` を2に設定。

### 圧縮サマリーの構造

```
<compact_summary>
## 会話サマリー（圧縮済み）
期間: 2026-04-03 14:30 〜 2026-04-04 10:15
メッセージ数: ユーザー5件、アシスタント5件

### ユーザーのリクエスト
1. [2026-04-03 14:30] SMtokyoのサーバーについて教えて
2. [2026-04-03 14:35] 登記簿の住所はどうなっている？
3. [2026-04-04 10:00] DDR8の見積書を確認して

### 参照した文書
- smtokyo鯖.md (ID: 24fd7719...)
- 登記 DDR8 20251222.pdf (ID: 22f86ea6...)
- 高橋様 足場王様案件 DDR8見積書.xlsx (ID: f4b6b27a...)

### 使用したツール
- search: 3回
- read_document: 4回
- list_folders: 1回

### 得られた主要な情報
- SMtokyoのサーバーはさくらインターネット東新宿とValueCore新北iDCに配置
- CakePHP 2.3.1 + PHP 5で稼働、セキュリティリスク大
- DDR8の登記上の本店は長野県軽井沢町（令和2年に東京から移転の記録あり）

### 直前の回答要旨
DDR8の見積書は足場材レンタル管理システムの開発見積もりで、
CakePHP 4.2 + PHP 8.0、MySQL/PostgreSQL構成...
</compact_summary>
```

### LLMによるサマリー生成 vs ルールベース生成

**ルールベースを採用する。** 理由:
- LLM呼び出しを追加するとレイテンシが増える
- 圧縮のたびにLLMコストがかかる
- LASの会話構造は定型的（検索→文書読込→回答のループ）なので、
  ルールベースで十分な品質のサマリーが作れる
- claw-codeも `summarize_messages()` はテンプレートベース（LLM不使用）

### 実装の詳細

#### 圧縮エンジン

**新ファイル**: `backend/app/services/compaction.py`

```python
from datetime import datetime

PRESERVE_RECENT_PAIRS = 2
MAX_ESTIMATED_TOKENS = 8000
CHAR_PER_TOKEN = 2  # 日本語

def estimate_tokens(messages: list[dict]) -> int:
    """メッセージリストの推定トークン数"""
    total_chars = sum(len(m.get("content", "")) for m in messages)
    return total_chars // CHAR_PER_TOKEN

def should_compact(messages: list[dict]) -> bool:
    """圧縮が必要か判定（systemメッセージを除く）"""
    # system以外のメッセージ
    non_system = [m for m in messages if m.get("role") != "system"]
    if len(non_system) <= PRESERVE_RECENT_PAIRS * 2:
        return False
    # 保持分を除いた古いメッセージのトークン数
    compactable = non_system[:-(PRESERVE_RECENT_PAIRS * 2)]
    return estimate_tokens(compactable) > MAX_ESTIMATED_TOKENS

def compact_messages(messages: list[dict]) -> list[dict]:
    """古いメッセージを圧縮サマリーに置換した新しいメッセージリストを返す"""
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    # 保持するメッセージ
    preserve_count = PRESERVE_RECENT_PAIRS * 2
    to_compact = non_system[:-preserve_count]
    to_preserve = non_system[-preserve_count:]

    # 既存のサマリーがあるか確認
    existing_summary = None
    if to_compact and to_compact[0].get("role") == "system":
        existing_summary = to_compact[0].get("content", "")
        to_compact = to_compact[1:]

    # サマリー生成
    summary = _build_summary(to_compact, existing_summary)

    # 新しいメッセージリスト: system + summary + preserved
    result = system_msgs.copy()
    result.append({"role": "system", "content": summary})
    result.extend(to_preserve)
    return result

def _build_summary(messages: list[dict], existing_summary: str | None) -> str:
    """メッセージ群から構造化サマリーを生成"""
    user_requests = []
    documents_referenced = []
    tools_used = {}
    key_findings = []

    for m in messages:
        content = m.get("content", "")
        role = m.get("role", "")
        created_at = m.get("created_at", "")
        time_prefix = f"[{created_at}] " if created_at else ""

        if role == "user":
            user_requests.append(f"{time_prefix}{content[:160]}")
        elif role == "assistant":
            # turn_contextからツール使用を抽出
            if "[前回のツール使用結果]" in content:
                tc_part = content.split("[前回のツール使用結果]")[1].split("[回答]")[0]
                for line in tc_part.strip().split("\n"):
                    if "(" in line and ")" in line:
                        tool_name = line.split("(")[0].strip()
                        tools_used[tool_name] = tools_used.get(tool_name, 0) + 1
            # 回答の要旨（最後のassistantメッセージのみ）
            answer_part = content
            if "[回答]" in content:
                answer_part = content.split("[回答]")[-1]
            key_findings.append(answer_part[:200])

    lines = ["<compact_summary>", "## 会話サマリー（圧縮済み）"]

    if existing_summary:
        lines.append(f"\n### 以前の圧縮コンテキスト\n{existing_summary}")
        lines.append("\n### 新たに圧縮された内容")

    user_count = sum(1 for m in messages if m.get("role") == "user")
    asst_count = sum(1 for m in messages if m.get("role") == "assistant")
    lines.append(f"メッセージ数: ユーザー{user_count}件、アシスタント{asst_count}件\n")

    if user_requests:
        lines.append("### ユーザーのリクエスト")
        for i, req in enumerate(user_requests[-5:], 1):  # 最大5件
            lines.append(f"{i}. {req}")

    if tools_used:
        lines.append("\n### 使用したツール")
        for tool, count in tools_used.items():
            lines.append(f"- {tool}: {count}回")

    if key_findings:
        lines.append("\n### 直前の回答要旨")
        lines.append(key_findings[-1])

    lines.append("</compact_summary>")
    return "\n".join(lines)
```

#### エージェントへの統合

**ファイル**: `backend/app/services/ai_agent.py`

```python
from app.services.compaction import should_compact, compact_messages

async def run_agent(...):
    # ... システムプロンプト構築 ...

    conv_messages = [{"role": "system", "content": system_content}]

    # メッセージ展開
    for m in messages:
        ...

    # 圧縮判定
    if should_compact(conv_messages):
        logger.info("Compacting conversation: %d messages", len(conv_messages))
        conv_messages = compact_messages(conv_messages)
        logger.info("After compaction: %d messages", len(conv_messages))

    # エージェントループ開始
    for round_num in range(1, max_rounds + 1):
        ...
```

#### DB永続化（オプション）

圧縮サマリーをDBに保存し、次回の会話復元時に使用:

**ファイル**: `backend/app/models.py` の `ChatConversation` に追加

```python
class ChatConversation(Base):
    ...
    compact_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
```

会話復元時に `compact_summary` があれば、古いメッセージの代わりにサマリーを使用。
これにより、DB→フロントエンド→バックエンドの全メッセージ転送を回避できる。

---

## フロー図

```
[ユーザーメッセージ]
        |
        v
[フロントエンド: 全メッセージをPOST]
        |
        v
[バックエンド: conv_messages構築]
        |
        v
[should_compact() 判定] ──No──> [そのままエージェントループへ]
        |
       Yes
        |
        v
[compact_messages(): 古いメッセージをサマリーに圧縮]
        |
        v
[圧縮後のconv_messagesでエージェントループ開始]
```

---

## 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `backend/app/services/compaction.py` | 新規: 圧縮エンジン |
| `backend/app/services/ai_agent.py` | 圧縮判定・実行の呼び出し追加 |
| `backend/app/models.py` | ChatConversationに `compact_summary` カラム追加（オプション） |

フロントエンドの変更は不要（圧縮はバックエンドで透過的に行われる）。

---

## 設定値の根拠

| パラメータ | 値 | 根拠 |
|-----------|-----|------|
| `preserve_recent_pairs` | 2 | 直近の2往復は文脈として必須。claw-codeの4メッセージと同等 |
| `max_estimated_tokens` | 8000 | llama-serverの1スロット32768トークンのうち、システムプロンプト+ツール定義で約3000、回答用に2048、余裕を含め8000が圧縮閾値として妥当 |
| `char_per_token` | 2 | 日本語テキストの平均。英語の4に対して日本語は2程度 |

---

## 将来の拡張

- **LLMベースの要約**: 品質向上が必要な場合、圧縮サマリーの生成にLLMを使用
- **段階的圧縮**: 古さに応じて圧縮の粒度を変える（1日前は詳細、1週間前は概要のみ）
- **トークン数の正確な計測**: tiktoken等を使ったトークナイザーベースの計測
- **ストリーミング中の動的圧縮**: エージェントループ中にトークン上限に近づいたら動的に圧縮
