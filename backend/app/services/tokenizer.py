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


@lru_cache(maxsize=1)
def _get_tokenizer() -> JanomeTokenizer:
    """Lazy-init singleton tokenizer."""
    return JanomeTokenizer()


def extract_nouns(text: str) -> list[str]:
    """Extract meaningful nouns from Japanese text.

    Examples:
        "ホスラブサーバーへのログイン方法" -> ["ホスラブサーバー", "ログイン", "方法"]
        "データセンターの入局方法" -> ["データセンター", "入局", "方法"]
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
        if surface in seen:
            continue

        seen.add(surface)
        nouns.append(surface)

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
