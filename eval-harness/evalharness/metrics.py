"""Eval metrics (spec 03 §9). Ported from the calibration spike. ROC-AUC is the
load-bearing separation metric (acceptance §12.1)."""

from __future__ import annotations

import numpy as np


def _average_ranks(sorted_values: np.ndarray) -> np.ndarray:
    n = len(sorted_values)
    ranks = np.empty(n, dtype=float)
    i = 0
    while i < n:
        j = i
        while j + 1 < n and sorted_values[j + 1] == sorted_values[i]:
            j += 1
        ranks[i : j + 1] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def roc_auc(scores: list[float], labels: list[int]) -> float:
    """ROC-AUC via the tie-aware Mann-Whitney U. label 1 = genuine, 0 = impostor."""
    s = np.asarray(scores, dtype=float)
    y = np.asarray(labels)
    n_pos = int((y == 1).sum())
    n_neg = int((y == 0).sum())
    if n_pos == 0 or n_neg == 0:
        raise ValueError("roc_auc needs both classes present")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), dtype=float)
    ranks[order] = _average_ranks(s[order])
    return float((ranks[y == 1].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))
