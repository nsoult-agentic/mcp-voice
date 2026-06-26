"""Stylometric feature set (spec 03 §5) → the StyleCard COMPUTED targets (spec 04 §4).

Measured, never described — so the style card can't drift from the corpus. Computed
identically over the author corpus (calibration) and any candidate (debugging via
/features). These are exactly the PRESERVE-list signals ingestion protected.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter

_WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
_SENT_RE = re.compile(r"[.!?]+")
_EMOJI_RE = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f1e6-\U0001f1ff\U00002190-\U000021ff]"
)
_CONTRACTION_RE = re.compile(r"[A-Za-z]+'[A-Za-z]+")
_PUNCT = {
    "em_dash": re.compile(r"—|--"),
    "comma": re.compile(r","),
    "period": re.compile(r"\."),
    "exclamation": re.compile(r"!"),
    "question": re.compile(r"\?"),
    "semicolon": re.compile(r";"),
    "colon": re.compile(r":"),
    "ellipsis": re.compile(r"\.\.\.|…"),
}


def _words(text: str) -> list[str]:
    return _WORD_RE.findall(text)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.split(text) if s.strip()]


def mattr(tokens: list[str], window: int = 50) -> float:
    """Moving-average type-token ratio (length-robust, NOT raw TTR). Mean of
    unique/window over sliding windows; falls back to unique/len for short text."""
    if not tokens:
        return 0.0
    lower = [t.lower() for t in tokens]
    if len(lower) <= window:
        return len(set(lower)) / len(lower)
    ratios = [len(set(lower[i : i + window])) / window for i in range(len(lower) - window + 1)]
    return sum(ratios) / len(ratios)


def signature_ngrams(texts: list[str], top_k: int = 8) -> list[str]:
    """Characteristic phrases: the most frequent word bigrams+trigrams across the
    corpus (deterministic; ties broken alphabetically)."""
    grams: Counter[str] = Counter()
    for text in texts:
        toks = [t.lower() for t in _words(text)]
        for n in (2, 3):
            for i in range(len(toks) - n + 1):
                grams[" ".join(toks[i : i + n])] += 1
    ranked = sorted(grams.items(), key=lambda kv: (-kv[1], kv[0]))
    return [g for g, c in ranked if c >= 2][:top_k]


def compute_targets(texts: list[str]) -> dict:
    """The StyleCard.targets dict (spec 04 §4a) over a corpus of documents."""
    joined = "\n".join(texts)
    all_words = _words(joined)
    total_words = max(len(all_words), 1)

    sent_lengths = [len(_words(s)) for s in _sentences(joined)]
    sent_lengths = [n for n in sent_lengths if n > 0]
    mean_len = statistics.mean(sent_lengths) if sent_lengths else 0.0
    var_len = statistics.pvariance(sent_lengths) if len(sent_lengths) > 1 else 0.0

    punct = {name: len(rx.findall(joined)) / total_words for name, rx in _PUNCT.items()}

    lc_starts = sum(1 for s in _sentences(joined) if s[:1].islower())
    n_sent = max(len(_sentences(joined)), 1)

    return {
        "sentence_len_mean": round(mean_len, 3),
        "sentence_len_variance": round(var_len, 3),
        "mattr": round(mattr(all_words), 4),
        "punctuation_profile": {k: round(v, 5) for k, v in punct.items()},
        "contraction_rate": round(len(_CONTRACTION_RE.findall(joined)) / total_words, 5),
        "emoji_rate": round(len(_EMOJI_RE.findall(joined)) / total_words, 5),
        "lowercase_start_rate": round(lc_starts / n_sent, 4),
        "signature_ngrams": signature_ngrams(texts),
        "word_count": total_words,
        "sample_count": len(texts),
    }


def word_count(text: str) -> int:
    return len(_words(text))
