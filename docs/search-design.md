# 検索システム設計書

## 概要

LASの検索は**統一マルチシグナルスコアリング**を採用。9つの検索シグナルを加重RRF（Reciprocal Rank Fusion）で統合し、通常検索・AI検索の両方で同一ロジックを使用する。

## アーキテクチャ

```
ユーザークエリ
    │
    ├─── tokenize_query() ← Janome形態素解析 → トークン列
    │
    ├─── 元のクエリ文字列（トークン化前）→ ベクトル検索に使用
    │
    ▼
┌────────────────────────────────────────────────────────┐
│  asyncio.gather (3並列、各独立DBセッション)             │
│                                                        │
│  ① メタデータシグナル (5つ、順次SQL)                    │
│     ├── タイトル一致      (weight: 8.0)                │
│     ├── タイトル全一致    (weight: 10.0) ← ボーナス    │
│     ├── ファイル名一致    (weight: 4.0)                │
│     ├── タグ一致          (weight: 3.0)                │
│     ├── メモ一致          (weight: 2.0)                │
│     └── サマリー一致      (weight: 2.0)                │
│                                                        │
│  ② 全文検索 (weight: 1.0)                              │
│     └── Chunk.content + Document.title                 │
│         pg_bigm GIN インデックス                        │
│                                                        │
│  ③ タイトルベクトル検索 (weight: 6.0)                   │
│     └── Document.title_embedding (1024次元, bge-m3)    │
│         pgvector IVFFlat cosine                        │
│         入力: 元のクエリ文字列（トークン化前）          │
└────────────────────────────────────────────────────────┘
    │
    ▼
加重RRF マージ + マッチ率²ペナルティ + 鮮度加算
    │
    ▼
ドキュメント単位で重複排除 → ページネーション → 結果返却
```

## シグナル詳細

### 1. タイトル一致 (weight: 8.0)

- **対象**: `Document.title`
- **方式**: pg_bigm ILIKE (`%token%`)
- **スコア**: トークン一致数でランキング
- **インデックス**: `ix_documents_title_bigm` (GIN, gin_bigm_ops)

タイトルに検索語が含まれるドキュメントを最優先。

### 2. タイトル全一致ボーナス (weight: 10.0)

- **対象**: `Document.title`
- **条件**: 全てのクエリトークンがタイトルに含まれる場合に付与
- **用途**: 複数語クエリで全語一致のタイトルを強力にブースト

タイトル一致シグナルの結果から、`match_count >= total_tokens` のドキュメントを抽出。
タイトル一致(8.0)に加えてボーナス(10.0)が加算されるため、合計18.0相当のweightとなる。

### 3. ファイル名一致 (weight: 4.0)

- **対象**: `Document.source_path`
- **方式**: ILIKE
- **用途**: 「会議資料.pdf」「report_2026.xlsx」などファイル名での検索

### 4. タグ一致 (weight: 3.0)

- **対象**: `Tag.name` (DocumentTag経由)
- **方式**: ILIKE部分一致
- **用途**: タグ名をクエリに含めると、そのタグが付いたドキュメントがブースト

### 5. メモ一致 (weight: 2.0)

- **対象**: `Document.memo`
- **方式**: ILIKE
- **用途**: ユーザーが付けたメモからの検索

### 6. サマリー一致 (weight: 2.0)

- **対象**: `Document.summary`
- **方式**: ILIKE
- **用途**: AI生成サマリーからの検索。概要レベルのキーワードヒット

### 7. コンテンツ全文一致 (weight: 1.0)

- **対象**: `Chunk.content` + `Document.title`
- **方式**: pg_bigm ILIKE
- **インデックス**: `ix_chunks_content_bigm` (GIN, gin_bigm_ops)
- **スコア**: チャンクごとのトークン一致数（content OR title でユニークカウント）
- **ドキュメント変換**: 最高ランクのチャンクの順位をドキュメントの順位として使用

### 8. タイトルベクトル検索 (weight: 6.0)

- **対象**: `Document.title_embedding` (1024次元ベクトル)
- **方式**: pgvector cosine distance
- **インデックス**: `ix_documents_title_embedding_cosine` (IVFFlat, lists=100)
- **閾値**: `_TITLE_VECTOR_MAX_DISTANCE = 0.6` (コード内定数)
- **モデル**: bge-m3
- **入力**: 元のクエリ文字列（トークン化前）

#### チャンクベクトルではなくタイトルベクトルを採用した理由

チャンクコンテンツのベクトル検索は、文書の断片が広範囲にヒットしすぎてノイジーだった。
タイトル+ファイル名のembeddingに限定することで：

- 表記ゆれに対応（「Smtokyo」→「sm-tokyo.com」、「SM東京」）
- チャンクより圧倒的にノイズが少ない
- ドキュメント単位で直接スコアリング（チャンク→ドキュメント変換が不要）

#### title_embedding の生成

タイトルとファイル名を結合してembeddingを生成：

```python
parts = [doc.title]
if doc.source_path and doc.source_path != doc.title:
    parts.append(doc.source_path)
title_text = " | ".join(parts)
# 例: "sm-tokyo.com サーバー一覧 | sm-tokyo_servers.md"
```

文書登録・更新時に自動生成。既存文書はバックフィルスクリプトで一括生成：
`backend/scripts/generate_title_embeddings.py`

#### ベクトルonlyヒットの特別処理

ベクトル検索のみでヒットし、テキストシグナルに一切マッチしない文書（`match_count=0`）は、
match_ratio²ペナルティを**免除**する。ベクトル検索は表記ゆれ対策が目的であり、
テキストマッチがなくて当然だから。

ただし、鮮度ブーストは加算しない（`mr=0.0`）。RRFスコアのみで順位が決まる。

### 9. 鮮度 (weight: 0.2)

- **対象**: `Document.updated_at`
- **方式**: 連続減衰関数（RRFランクではない）
- **半減期**: 30日

```
freshness(doc) = 1.0 / (1.0 + days_since_update / 30.0)
```

| 経過日数 | freshness | 加算スコア (×0.2) |
|----------|-----------|-------------------|
| 0日      | 1.000     | 0.200             |
| 7日      | 0.811     | 0.162             |
| 30日     | 0.500     | 0.100             |
| 90日     | 0.250     | 0.050             |
| 365日    | 0.076     | 0.015             |

## スコアリング: 加重RRF + マッチ率²ペナルティ

```python
K = 60  # RRF定数

# Step 1: RRFシグナル (ランクベース)
for signal_name, ranked_doc_ids in signals.items():
    weight = SIGNAL_WEIGHTS[signal_name]
    for rank, doc_id in enumerate(ranked_doc_ids, start=1):
        score[doc_id] += weight * (1.0 / (K + rank))

# Step 2: マッチ率²ペナルティ (トークンが2つ以上の場合)
# 全トークンのうち何割がマッチしたかの二乗でスコアを乗算
# 二乗にすることで部分一致を強力に抑制
# ベクトルonlyヒット (mc=0) はペナルティ免除
if total_tokens > 1:
    for doc_id in scores:
        if match_count == 0 and doc_id in vector_hits:
            continue  # ベクトルonly → ペナルティ免除
        match_ratio = min(match_count, total_tokens) / total_tokens
        score[doc_id] *= match_ratio ** 2

# Step 3: 鮮度シグナル (ペナルティ適用後に加算)
# 鮮度もmatch_ratio²でスケール。ベクトルonlyは鮮度なし (mr=0.0)
for doc_id in all_docs:
    mr = 0.0 if (mc == 0 and vector_only) else match_ratio
    score[doc_id] += 0.2 * freshness(doc) * mr ** 2
```

### マッチ率の算出

`match_count` はメタデータシグナルと全文検索の両方から最大値を取る。

- **全文検索**: 各チャンクで `OR(content ILIKE, title ILIKE)` のCASE式で各トークンの一致を0/1でカウント
  - 1トークンがcontent+title両方にマッチしても1としてカウント（二重カウント防止）
- **メタデータシグナル**: 各シグナル（title, filename, memo, summary, tag）のmcを追跡
- **ドキュメント全体**: 全シグナルのmcの最大値を使用

### マッチ率²ペナルティの効果

二乗ペナルティにより、部分一致ドキュメントのスコアを**強力に**抑制する。

| クエリ | マッチ状況 | match_ratio | match_ratio² | 効果 |
|--------|-----------|-------------|-------------|------|
| 「Smtokyo サーバー」 | 両方マッチ | 1.0 | 1.0 | スコア維持 |
| 「Smtokyo サーバー」 | 「サーバー」のみ | 0.5 | 0.25 | スコア1/4 |
| 「A B C」 | 「A」のみ | 0.33 | 0.11 | スコア1/9 |
| 「A B C」 | 「A B」マッチ | 0.67 | 0.44 | スコア約半分 |

**重要**: ペナルティはRRFスコアに乗算した**後**に鮮度を加算する。鮮度もmatch_ratio²でスケールされるため、マッチ率が低いドキュメントは鮮度ブーストだけでは上位に来られない。

### スコア例

| シナリオ | RRFスコア | match_ratio² | ペナルティ後 | 鮮度(×mr²) | 合計 |
|----------|----------|-------------|-------------|------|------|
| 2語全一致 + 最新 | 0.114 | 1.0 | 0.114 | 0.200 | 0.314 |
| 2語中1語 + 最新 | 0.032 | 0.25 | 0.008 | 0.050 | 0.058 |
| 2語全一致 + 古い | 0.114 | 1.0 | 0.114 | 0.015 | 0.129 |
| 2語中1語 + 古い | 0.032 | 0.25 | 0.008 | 0.004 | 0.012 |
| ベクトルonly rank1 + 最新 | 0.098 | (免除) | 0.098 | 0.000 | 0.098 |

## 実装ファイル

| ファイル | 役割 |
|----------|------|
| `backend/app/services/search.py` | 検索コアロジック (全シグナル + RRFマージ) |
| `backend/app/services/embedding.py` | 埋め込みベクトル取得 (bge-m3) |
| `backend/app/services/tokenizer.py` | クエリトークン化 (Janome形態素解析) |
| `backend/app/services/document_processing.py` | 文書処理パイプライン (title_embedding自動生成含む) |
| `backend/app/services/agent_tools.py` | AI検索ツール (merged_searchを呼び出し) |
| `backend/app/routers/search.py` | 検索APIエンドポイント |
| `backend/app/models.py` | Document, Chunk, Tag モデル + インデックス定義 |
| `backend/scripts/generate_title_embeddings.py` | タイトルembeddingバックフィルスクリプト |

## AI検索との統合

AI agentの`search`ツールは`merged_search()`を直接呼び出す。通常検索と同一のスコアリングロジックを使用するため、検索品質が統一される。

```
AI Agent Tools:
├── search      → merged_search() [統一スコアリング]
├── grep        → grep_search()   [完全一致、精密検索]
├── title_search → title_search() [タイトル特化]
├── read_document                  [全文取得]
└── count_results                  [件数カウント]
```

## パフォーマンス

- メタデータ5シグナルは1つの関数内で順次実行（各クエリはGINインデックス使用で高速）
- 全文検索・タイトルベクトル検索・メタデータ検索は`asyncio.gather`で**真の並列実行**（独立DBセッション使用）
- 候補上限: 各シグナル最大200件
- RRFマージはメモリ上で実行（O(n)、n ≤ 200×8）
- DBプール: pool_size=30, max_overflow=20（並列検索用に余裕を確保）

## 設定パラメータ

| パラメータ | 場所 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `_SIGNAL_WEIGHTS` | search.py | 上記表 | 各シグナルの重み |
| `_TITLE_VECTOR_MAX_DISTANCE` | search.py | 0.6 | タイトルベクトル検索のcosine距離閾値 (similarity ≥ 40%) |
| `_FRESHNESS_WEIGHT` | search.py | 0.2 | 鮮度シグナルの重み |
| `_FRESHNESS_HALF_LIFE_DAYS` | search.py | 30.0 | 鮮度半減期（日） |
| `_K` | search.py | 60 | RRF定数 |
| `vector_similarity_threshold` | システム設定DB | 50% | チャンクベクトル検索の類似度閾値 (旧方式、現在未使用) |

## 既知の課題・今後の改善案

### トークナイザー

- **複合語分裂**: 「Sm-tokyo」が「Sm」「tokyo」に分割される（日本語混在時にJanomeに渡されるため）
- **接頭辞欠落**: 「再起動」が「起動」になる（「再」は接頭詞で1文字フィルターで消える）
- 改善案: 日本語/ASCII境界での事前分割、接頭詞の結合

### 表記ゆれ

- ILIKEでは「smtokyo」で「sm-tokyo」にマッチしない（記号の壁）
- ベクトル検索でカバーするが、類似ドメイン（walls-tokyo等）もヒットしうる
- 改善案: クエリ/DB側の記号除去正規化

### その他

1. **重みのシステム設定化** — 管理画面から重みを調整可能にする
2. **pg_bigmスコアリング強化** — `bigm_similarity()`関数でより正確な類似度を使用
3. **フォルダ名シグナル追加** — Folder.nameでの検索
4. **HNSWインデックス** — IVFFlatからHNSWに変更してリコール率向上
5. **クエリ拡張** — 同義語辞書やLLMによるクエリリライト
6. **fulltext match_countによる動的weight** — 多くのトークンがマッチしたチャンクのRRF寄与をブースト
