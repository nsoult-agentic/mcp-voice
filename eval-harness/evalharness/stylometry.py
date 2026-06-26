"""Cosine-Delta stylometry (spec 03 §6) — the PRIMARY Gate-A signal.

Ported from the calibration spike (validated there: ROC-AUC 1.0 separating the
operator from other authors). Burrows-style: relative frequencies of the most
frequent words, z-scored against a REFERENCE corpus (not the author alone, which
would make the author centroid the zero vector), compared by cosine.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

import numpy as np

_TOKEN_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens, contractions kept. No stopword removal — function
    words ARE the signal."""
    return _TOKEN_RE.findall(text.lower())


def most_frequent_words(texts: list[str], n: int) -> list[str]:
    counts: Counter[str] = Counter()
    for text in texts:
        counts.update(tokenize(text))
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [w for w, _ in ranked[:n]]


def relative_frequencies(text: str, vocab: list[str]) -> np.ndarray:
    tokens = tokenize(text)
    total = len(tokens)
    if total == 0:
        return np.zeros(len(vocab), dtype=float)
    counts = Counter(tokens)
    return np.array([counts.get(w, 0) / total for w in vocab], dtype=float)


@dataclass
class CosineDeltaScorer:
    vocab: list[str]
    mean: list[float]
    std: list[float]
    centroid: list[float]

    @classmethod
    def fit(
        cls, genuine_texts: list[str], reference_texts: list[str], mfw_count: int
    ) -> CosineDeltaScorer:
        if not genuine_texts:
            raise ValueError("CosineDeltaScorer.fit needs >= 1 genuine document")
        if not reference_texts:
            raise ValueError("CosineDeltaScorer.fit needs a reference corpus")
        vocab = most_frequent_words(reference_texts, mfw_count)
        ref = np.array([relative_frequencies(t, vocab) for t in reference_texts])
        mean = ref.mean(axis=0)
        std = np.where(ref.std(axis=0) == 0, 1.0, ref.std(axis=0))
        genuine = np.array([relative_frequencies(t, vocab) for t in genuine_texts])
        centroid = ((genuine - mean) / std).mean(axis=0)
        return cls(vocab=vocab, mean=mean.tolist(), std=std.tolist(), centroid=centroid.tolist())

    def similarity(self, text: str) -> float:
        """Cosine similarity of the text's z-vector to the author centroid; higher =
        more author-like. 0 for a zero vector."""
        mean = np.asarray(self.mean)
        std = np.asarray(self.std)
        centroid = np.asarray(self.centroid)
        z = (relative_frequencies(text, self.vocab) - mean) / std
        nz = float(np.linalg.norm(z))
        nc = float(np.linalg.norm(centroid))
        if nz == 0 or nc == 0:
            return 0.0
        return float(np.dot(z, centroid) / (nz * nc))

    def to_dict(self) -> dict:
        return {"vocab": self.vocab, "mean": self.mean, "std": self.std, "centroid": self.centroid}

    @classmethod
    def from_dict(cls, d: dict) -> CosineDeltaScorer:
        return cls(vocab=d["vocab"], mean=d["mean"], std=d["std"], centroid=d["centroid"])
