# AIエージェント スキルシステム

## 背景と問題

LASには法的文書（登記簿、定款、契約書）、技術文書（サーバー構成、コード分析）、
経理文書（請求書、見積書）、建築文書（足場、工事）など多種多様な文書が格納されている。

現在のエージェントは全ての文書を同じように扱っており、ドメイン固有の解釈ルールがない。
これにより以下の問題が発生している:

- 登記簿の履歴事項全部証明書を正しく読めない（最新記録の特定ができない）
- 見積書の構造（項目、単価、合計）を理解した分析ができない
- 技術文書の専門用語やアーキテクチャの文脈を把握できない

### 参考: Claude Codeのスキルシステム

Claude Codeでは3層のスキル構造を持つ:

1. **バンドルスキル** — バイナリに組み込み（simplify, debug, commit等）
2. **プロジェクトスキル** — `.claude/commands/<name>.md` または `.claude/skills/<name>/SKILL.md`
3. **ユーザースキル** — `~/.claude/commands/<name>.md`

各スキルはMarkdownファイルで、YAMLフロントマター（name, description, tags）+ 本文。
`$ARGUMENTS` で引数を展開。優先順位: バンドル > プロジェクト > ユーザー。

---

## 現状の実装

### システムプロンプト

`SYSTEM_PROMPT` は単一の固定文字列。ドメイン固有の知識や解釈ルールは一切含まれていない。

```python
SYSTEM_PROMPT = """\
あなたは社内文書検索AIアシスタントです。
...
## 注意
- ツールで見つけた情報のみを元に回答してください。推測で答えないでください。
...
"""
```

### 動的コンテキスト注入

`ai_agent.py` の `run_agent()` でシステムプロンプトに以下を動的追加:
- フォルダツリー
- 前回の検索コンテキスト

スキルの概念は存在しない。

---

## 設計

### スキルファイルの形式

Claude Codeと同じMarkdown + YAMLフロントマター形式を採用する。

```yaml
---
name: legal
description: 法的文書（登記簿、定款、契約書、覚書）の解釈スキル
tags: [登記, 定款, 契約書, 覚書, 議事録, 法人, 商業登記]
---

## このスキルが有効な場合
登記簿、定款、契約書などの法的文書を読み解く必要がある場合に適用してください。

## 解釈ルール
- 登記簿（履歴事項全部証明書）は過去の全変更履歴を含む文書です
- 最新の情報は、最も日付が新しい記録を参照してください
- 「令和○年○月○日」の日付が複数ある場合、最新日付の記録が現在の状態です
- 住所変更（本店移転）は「○○から移転」の記録で、移転先が新住所です
- 和暦は必ず西暦に変換して判断してください

## 注意事項
- 法的文書の内容を推測で補完しないでください
- 「可能性がある」「と思われる」のような曖昧な表現は避け、
  文書に記載されている事実のみを報告してください
- 記載がない事項については「記載なし」と明記してください
```

### スキルの格納場所

```
backend/app/skills/
  legal.md          # 法的文書
  finance.md        # 経理・請求書・見積書
  technical.md      # IT・サーバー・インフラ
  construction.md   # 建築・工事・足場
  hr.md             # 人事・社員情報
  general.md        # 汎用（要約、比較、リスト作成）
```

ファイルシステムに配置する。DBに入れない理由:
- バージョン管理（git）できる
- デプロイが単純（ファイルコピー）
- 編集がMarkdownエディタで可能
- Claude Codeと同じパターン

### スキルのロード方法

**案A: エージェントがツールで明示的にロード**

新ツール `load_skill` を追加:

```json
{
  "name": "load_skill",
  "description": "ドメイン固有の解釈スキルをロードします。文書の種類に応じて適切なスキルを選択してください。",
  "parameters": {
    "properties": {
      "name": {"type": "string", "description": "スキル名（legal, finance, technical, construction, hr, general）"}
    },
    "required": ["name"]
  }
}
```

エージェントが文書を読んだ後、必要と判断したらスキルをロード。
スキル内容はtoolの結果として返され、LLMのコンテキストに入る。

**案B: 自動検出 + システムプロンプト注入**

検索結果のファイルタイプやキーワードから自動判定し、
関連スキルをシステムプロンプトに事前注入。

```python
async def _detect_skills(query: str, results: list[dict]) -> list[str]:
    """検索クエリと結果からロードすべきスキルを判定"""
    skills = set()
    keywords = {
        "legal": ["登記", "定款", "契約", "覚書", "議事録"],
        "finance": ["請求", "見積", "経理", "売上", "入金"],
        "technical": ["サーバー", "API", "DB", "コード", "システム"],
        "construction": ["足場", "工事", "建築", "施工"],
    }
    text = query.lower()
    for skill_name, words in keywords.items():
        if any(w in text for w in words):
            skills.add(skill_name)
    # 結果のタイトルからも判定
    for r in results:
        title = r.get("document_title", "").lower()
        for skill_name, words in keywords.items():
            if any(w in title for w in words):
                skills.add(skill_name)
    return list(skills)
```

**採用: 案Aと案Bのハイブリッド**

- 1ラウンド目の検索結果から自動検出し、システムプロンプトに注入（案B）
- エージェントが追加で必要と判断した場合に `load_skill` ツールで手動ロード（案A）
- スキルは1つの会話で複数ロード可能
- ロード済みスキルは重複して注入しない

### 実装の詳細

#### スキルローダー

**新ファイル**: `backend/app/services/skills.py`

```python
import os
from pathlib import Path

import yaml

SKILLS_DIR = Path(__file__).parent.parent / "skills"

def list_skills() -> list[dict]:
    """利用可能なスキル一覧を返す"""
    skills = []
    for path in sorted(SKILLS_DIR.glob("*.md")):
        meta, body = _parse_skill(path)
        skills.append({
            "name": meta.get("name", path.stem),
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
        })
    return skills

def load_skill(name: str) -> str | None:
    """スキルファイルを読み込み、本文を返す"""
    path = SKILLS_DIR / f"{name}.md"
    if not path.exists():
        return None
    meta, body = _parse_skill(path)
    return body

def match_skills(text: str) -> list[str]:
    """テキストに関連するスキルを自動検出"""
    matched = []
    for path in SKILLS_DIR.glob("*.md"):
        meta, _ = _parse_skill(path)
        tags = meta.get("tags", [])
        if any(tag in text for tag in tags):
            matched.append(meta.get("name", path.stem))
    return matched

def _parse_skill(path: Path) -> tuple[dict, str]:
    """YAMLフロントマター + 本文をパース"""
    content = path.read_text(encoding="utf-8")
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            meta = yaml.safe_load(parts[1]) or {}
            body = parts[2].strip()
            return meta, body
    return {}, content
```

#### エージェントへの統合

**ファイル**: `backend/app/services/ai_agent.py`

```python
from app.services.skills import load_skill, match_skills

async def run_agent(...):
    # システムプロンプト構築
    system_content = SYSTEM_PROMPT

    # 現在日時（時間的概念と連動）
    system_content += f"\n\n## 現在日時\n{date_str}\n"

    # フォルダツリー
    ...

    # スキル自動検出（ユーザーの最新メッセージから）
    user_query = messages[-1]["content"] if messages else ""
    auto_skills = match_skills(user_query)
    loaded_skills: set[str] = set()
    for skill_name in auto_skills:
        body = load_skill(skill_name)
        if body:
            system_content += f"\n\n## スキル: {skill_name}\n{body}"
            loaded_skills.add(skill_name)
```

#### load_skill ツール

**ファイル**: `backend/app/services/agent_tools.py`

ツール定義を追加:
```python
{
    "type": "function",
    "function": {
        "name": "load_skill",
        "description": "ドメイン固有の解釈スキルをロードします。利用可能: legal（法的文書）, finance（経理）, technical（技術）, construction（建築）, hr（人事）, general（汎用）",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "スキル名"}
            },
            "required": ["name"],
        },
    },
},
```

ツール実行:
```python
elif name == "load_skill":
    skill_name = arguments.get("name", "")
    body = load_skill(skill_name)
    if body is None:
        available = ", ".join(s["name"] for s in list_skills())
        return f"スキル「{skill_name}」は存在しません。利用可能: {available}", sources
    return f"スキル「{skill_name}」をロードしました:\n\n{body}", sources
```

注意: `load_skill` ツールの結果はtool messageとしてコンテキストに入るため、
LLMは以降のラウンドでスキルの指示を参照できる。

#### フロントエンド

**ファイル**: `frontend/src/components/ChatPanel.tsx`

```typescript
const TOOL_LABELS = {
  ...
  load_skill: { label: "スキル読込", icon: BookOpen },
};
```

---

## スキルファイルの初期セット

| ファイル | 対象文書 | 主な指示内容 |
|----------|----------|-------------|
| `legal.md` | 登記簿、定款、契約書 | 履歴文書の読み方、最新記録の特定、和暦変換 |
| `finance.md` | 請求書、見積書、経理帳票 | 金額の読み取り、税計算、項目構造の理解 |
| `technical.md` | サーバー構成、コード分析 | アーキテクチャ用語、バージョン情報、依存関係 |
| `construction.md` | 工事、足場、施工 | 建築用語、安全基準、工程管理 |
| `hr.md` | 社員情報、入社ガイド | 個人情報の取り扱い注意、組織構造 |
| `general.md` | 汎用 | 要約、比較表、リスト作成の指示 |

---

## 将来の拡張

- **管理画面からのスキル編集**: UI上でスキルのMarkdownを編集・追加できる機能
- **スキルの利用統計**: どのスキルがよく使われているかを記録
- **ユーザー別スキル**: 特定ユーザーだけに有効なスキルの設定
- **スキルの自動学習**: エージェントの回答品質からスキルを改善する仕組み

---

## 影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `backend/app/skills/*.md` | 新規: スキルファイル群 |
| `backend/app/services/skills.py` | 新規: スキルローダー |
| `backend/app/services/agent_tools.py` | load_skillツール定義・実行追加、SYSTEM_PROMPTにスキル案内追加 |
| `backend/app/services/ai_agent.py` | スキル自動検出・注入ロジック追加 |
| `frontend/src/components/ChatPanel.tsx` | load_skillのツールラベル追加 |
