"""Japanese tokenizer using Janome for noun extraction.

Splits Japanese text into meaningful nouns for AND-search queries.
The original query text is preserved in the UI — only the backend
uses this for fulltext search decomposition.
"""

import re
from functools import lru_cache

from janome.tokenizer import Tokenizer as JanomeTokenizer

# Noun part-of-speech tags to keep
_NOUN_POS = {"名詞"}
# Sub-categories to exclude (particles, suffixes, pronouns, etc.)
_NOUN_EXCLUDE_SUB = {"非自立", "代名詞", "接尾"}

# Minimum token length to keep
_MIN_TOKEN_LEN = 2

# Pattern to detect segments that should NOT be tokenized
# (model numbers, product codes, URLs, etc.)
_NON_JAPANESE_RE = re.compile(r"^[a-zA-Z0-9\-_./:#@&?=%+]+$")

# Pattern to detect if text contains Japanese characters
_JAPANESE_RE = re.compile(r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]")

# Katakana long-vowel mark
_KATAKANA_RE = re.compile(r"[\u30A0-\u30FF]+")
# Threshold: split katakana compound nouns longer than this
_KATAKANA_SPLIT_THRESHOLD = 5


@lru_cache(maxsize=1)
def _get_tokenizer() -> JanomeTokenizer:
    """Lazy-init singleton tokenizer."""
    return JanomeTokenizer()


def _split_long_katakana(surface: str) -> list[str]:
    """Split long katakana compound words by re-tokenizing with Janome.

    Janome sometimes merges unknown katakana compounds into a single token
    (e.g. "ホスラブサーバー"). We re-tokenize the surface itself — if Janome
    can split it further, we use the sub-tokens. Otherwise we also try
    splitting at katakana long-vowel mark (ー) boundaries as a heuristic.
    """
    if len(surface) <= _KATAKANA_SPLIT_THRESHOLD:
        return [surface]
    if not _KATAKANA_RE.fullmatch(surface.replace("ー", "")):
        return [surface]

    tokenizer = _get_tokenizer()
    # Re-tokenize the katakana surface alone — sometimes Janome splits better in isolation
    sub_tokens = [t.surface for t in tokenizer.tokenize(surface) if len(t.surface) >= _MIN_TOKEN_LEN]
    if len(sub_tokens) > 1:
        return sub_tokens

    # Heuristic: split before common katakana suffixes
    # e.g. ホスラブサーバー → ホスラブ + サーバー
    _KATAKANA_SUFFIXES = [
        "サーバー", "サーバ", "サービス", "システム", "センター", "ネットワーク",
        "プロジェクト", "マネージャー", "マネージャ", "コントローラー", "コントローラ",
        "データベース", "インターフェース", "アプリケーション", "クライアント",
        "プロバイダー", "プロバイダ", "モニター", "モニタ", "ストレージ",
        "ドメイン", "ポート", "ホスト", "メール", "ファイル", "フォルダ",
    ]
    for suffix in _KATAKANA_SUFFIXES:
        if surface.endswith(suffix) and len(surface) > len(suffix):
            prefix = surface[:-len(suffix)]
            if len(prefix) >= _MIN_TOKEN_LEN:
                return [prefix, suffix]

    # No split found — return original
    return [surface]


def extract_nouns(text: str) -> list[str]:
    """Extract meaningful nouns from Japanese text.

    Examples:
        "ホスラブサーバーへのログイン方法" -> ["ホスラブ", "サーバー", "ログイン", "方法"]
        "データセンターの入局方法" -> ["データ", "センター", "入局", "方法"]
    """
    tokenizer = _get_tokenizer()
    nouns: list[str] = []
    seen: set[str] = set()

    for token in tokenizer.tokenize(text):
        parts = token.part_of_speech.split(",")
        pos = parts[0]
        sub_pos = parts[1] if len(parts) > 1 else ""

        if pos not in _NOUN_POS:
            continue
        if sub_pos in _NOUN_EXCLUDE_SUB:
            continue

        surface = token.surface.strip()
        if len(surface) < _MIN_TOKEN_LEN:
            continue

        # Try splitting long katakana compound words
        sub_words = _split_long_katakana(surface)
        for w in sub_words:
            if w not in seen and len(w) >= _MIN_TOKEN_LEN:
                seen.add(w)
                nouns.append(w)

    return nouns


def tokenize_query(query: str) -> list[str]:
    """Tokenize a search query into keywords for AND matching.

    Strategy:
    1. If query contains spaces, split and tokenize each segment
    2. For segments with Japanese text, extract nouns via morphological analysis
    3. For non-Japanese segments (model numbers, ASCII codes), keep as-is
    4. If tokenization yields nothing, fall back to original segment

    The result is a list of keywords suitable for ILIKE %word% matching.
    """
    query = query.strip()
    if not query:
        return []

    # Split by whitespace first (user may have manually separated terms)
    segments = query.split()

    all_keywords: list[str] = []
    seen: set[str] = set()

    def _add(word: str) -> None:
        word = word.strip()
        if word and word not in seen:
            seen.add(word)
            all_keywords.append(word)

    for segment in segments:
        # Non-Japanese text (model numbers, codes, etc.) → keep as-is
        if _NON_JAPANESE_RE.match(segment):
            _add(segment)
            continue

        # Contains Japanese → extract nouns
        if _JAPANESE_RE.search(segment):
            nouns = extract_nouns(segment)
            if nouns:
                for n in nouns:
                    _add(n)
                continue

        # Fallback: use segment as-is
        _add(segment)

    return all_keywords
