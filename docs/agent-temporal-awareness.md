# AIエージェント 時間的概念の導入

## 背景と問題

LASのAIエージェントは時間の概念を一切持っていない。これにより以下の問題が発生している。

### 発生した具体的な問題

**登記簿の誤解釈**: 「登記 DDR8 20251222.pdf」（2025年12月22日発行）を読み込んだ際、
登記簿に記載された「令和2年11月1日」の本店移転記録を「最新の情報」として扱った。
実際には令和2年（2020年）は5年以上前であり、その後さらに住所が変わっている可能性を
考慮できなかった。エージェントが「現在が2026年4月である」ことを知っていれば、
「令和2年の記録は6年前のもの」と正しく認識できた。

**会話日時の混同**: 昨日と今日の会話が区別されず、前回の会話で得た情報と
今回の情報がごっちゃになることがある。

---

## 現状の実装

### システムプロンプト (`agent_tools.py` SYSTEM_PROMPT)

```
あなたは社内文書検索AIアシスタントです。
ユーザーの質問に答えるため、提供されたツールを使って情報を探してください。
...
```

- 現在日時の記載なし
- 文書の鮮度に関する指示なし
- 和暦・西暦の変換指示なし

### 検索結果のフォーマット (`agent_tools.py` execute_tool)

```
search結果:
- **文書タイトル** (ID: uuid)
  スニペット...

read_document結果:
- **文書タイトル** の全文:
  内容...
```

- `updated_at` はDB/検索エンジンに存在するが、ツール出力に含まれていない
- `created_at` も同様に表示されていない
- 文書の経過日数の計算なし

### 会話履歴 (`ai_agent.py` run_agent)

```python
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

- 各メッセージの日時情報なし
- 「前回のツール使用結果」にタイムスタンプなし
- 会話が何日にまたがっているか判別不能

### 動的コンテキスト注入 (`ai_agent.py` run_agent)

```python
system_content = SYSTEM_PROMPT
# フォルダツリー注入
folder_tree = await _build_folder_tree(db)
if folder_tree:
    system_content += f"\n\n## フォルダ構造\n..."
# 既存コンテキスト注入
if existing_context:
    system_content += f"\n\n## 前回の検索で取得済みのコンテキスト:\n..."
```

- 現在日時の注入なし

---

## 設計

### 参考: Claude Code / claw-code の実装

Claude Codeでは以下の手法を使用:
- システムプロンプトの動的セクションに `"Today's date is YYYY-MM-DD."` を毎ターン注入
- メモリの鮮度表示: `memoryAgeDays()` で「このメモリはN日前のものです」と注意書き
- 60分以上経過したツール結果を `[Old tool result content cleared]` に置換

LASは文書管理システムであるため、Claude Codeより踏み込んだ時間的概念が必要。

### 変更箇所

#### 1. システムプロンプトへの現在日時注入

**ファイル**: `backend/app/services/ai_agent.py` の `run_agent()`

```python
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
now = datetime.now(JST)
weekdays = ["月", "火", "水", "木", "金", "土", "日"]
date_str = now.strftime(f"%Y年%-m月%-d日({weekdays[now.weekday()]}) %H:%M JST")

system_content = SYSTEM_PROMPT
system_content += f"\n\n## 現在日時\n{date_str}\n"
```

#### 2. システムプロンプトに時間的推論の指示を追加

**ファイル**: `backend/app/services/agent_tools.py` の `SYSTEM_PROMPT`

```
## 時間的判断
- 現在日時と文書の更新日を比較し、情報の鮮度を考慮してください
- 古い文書（1年以上前）の情報は「当時の情報」として扱い、現在も有効か注意してください
- 和暦（令和/平成/昭和）は西暦に変換して時系列を正確に把握してください
  - 令和元年 = 2019年、令和2年 = 2020年、...
  - 平成元年 = 1989年、平成31年 = 2019年
- 登記簿などの履歴文書は、最も日付が新しい記録が最新情報です
- 複数の文書で矛盾する情報がある場合、より新しい文書を優先してください
```

#### 3. 検索結果に文書の日付を表示

**ファイル**: `backend/app/services/agent_tools.py` の `execute_tool()`

search結果のフォーマットを変更:

```
現在:
- **文書タイトル** (ID: uuid)
  スニペット...

変更後:
- **文書タイトル** (ID: uuid, 更新: 2025-12-22, 3ヶ月前)
  スニペット...
```

実装: `merged_search` の返り値に既に `updated_at` が含まれている。
経過日数を計算して表示に追加する。

```python
from datetime import datetime, timezone, timedelta

def _format_age(updated_at_iso: str | None) -> str:
    """文書の更新日と経過期間を表示用文字列にする"""
    if not updated_at_iso:
        return ""
    try:
        dt = datetime.fromisoformat(updated_at_iso)
        now = datetime.now(timezone.utc)
        days = (now - dt).days
        if days == 0:
            age = "今日"
        elif days == 1:
            age = "昨日"
        elif days < 30:
            age = f"{days}日前"
        elif days < 365:
            age = f"{days // 30}ヶ月前"
        else:
            age = f"{days // 365}年前"
        date_str = dt.strftime("%Y-%m-%d")
        return f", 更新: {date_str}, {age}"
    except Exception:
        return ""
```

各ツールの出力に適用:

| ツール | 変更内容 |
|--------|----------|
| search | 各結果に `更新: YYYY-MM-DD, Nヶ月前` を追加 |
| search_by_title | 同上 |
| read_document | ヘッダに `更新日: YYYY-MM-DD（N日前）` を追加 |
| grep | 各結果に更新日を追加 |
| list_documents | 各文書に更新日を追加 |

#### 4. read_document に文書メタデータを追加

現在:
```
**文書タイトル** の全文:

内容...
```

変更後:
```
**文書タイトル**
更新日: 2025-12-22（3ヶ月前） | タイプ: pdf | フォルダ: 経理/DDR8

全文:
内容...
```

#### 5. 会話履歴に日時を付与

**ファイル**: `backend/app/services/ai_agent.py` の会話メッセージ構築部分

```python
for m in messages:
    # メッセージの日時情報を付与
    msg_time = ""
    if m.get("created_at"):
        msg_time = f"[{m['created_at']}] "

    if m.get("turn_context") and m.get("role") == "assistant":
        augmented = (
            f"{msg_time}[前回のツール使用結果]\n{m['turn_context']}\n\n"
            f"[回答]\n{m['content']}"
        )
        conv_messages.append({"role": "assistant", "content": augmented})
    elif msg_time and m.get("role") == "user":
        conv_messages.append({"role": "user", "content": f"{msg_time}{m['content']}"})
    else:
        conv_messages.append({"role": m["role"], "content": m["content"]})
```

**ファイル**: `backend/app/routers/chat.py` の `chat_stream()`

メッセージにDBからの `created_at` を渡す:

```python
messages = [
    {
        "role": m.role,
        "content": m.content,
        **({\"turn_context\": m.turn_context} if m.turn_context else {}),
        **({\"created_at\": m.created_at} if hasattr(m, 'created_at') else {}),
    }
    for m in body.messages
]
```

フロントエンドからの送信時に `created_at` を含める、
またはバックエンドで会話DBから復元時に付与する。

---

## 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `backend/app/services/agent_tools.py` | SYSTEM_PROMPT に時間的判断の指示追加、ツール出力に日付表示追加、`_format_age()` 関数追加 |
| `backend/app/services/ai_agent.py` | 現在日時注入、会話メッセージへの日時付与 |
| `backend/app/routers/chat.py` | メッセージに `created_at` を含める |
| `frontend/src/lib/api/search.ts` | メッセージ送信時に `created_at` を含める（必要に応じて） |

## テスト方法

1. チャットで「今日は何日？」と聞いて正しい日時が返ることを確認
2. 古い文書を検索して「N年前の文書です」と表示されることを確認
3. 登記簿など時系列を含む文書を読ませて、和暦→西暦変換と最新記録の特定ができることを確認
4. 日をまたいだ会話で「昨日の会話」と「今日の会話」が区別されることを確認
