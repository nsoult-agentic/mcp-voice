"""Calibration (spec 03 §8) — what makes a similarity score mean something.

Builds, per (author_id, register): the author centroid (Cosine-Delta scorer) and
the author-vs-impostor score distribution from which Gate-A percentile thresholds
are derived. Also computes the StyleCard targets (spec 04 §4a). The resulting blob
is cached in the sidecar and returned for `storage` to persist into voice.profiles.

Negatives are BOTH AI text and a public other-humans corpus (decision E1); callers
pass them combined as `impostors`.
"""

from __future__ import annotations

from . import features
from .metrics import roc_auc
from .stylometry import CosineDeltaScorer

DEFAULT_MFW = 200
# Below this author-vs-impostor ROC-AUC the centroid can't tell the author from
# strangers — the stylometric gate is meaningless, so flag the profile (spec §8,
# build-phase guard). The gate then refuses to confidently PASS against it.
MIN_SEPARATION_AUC = 0.6


def calibrate(
    genuine: list[str],
    impostors: list[str],
    register: str,
    mfw_count: int = DEFAULT_MFW,
) -> dict:
    if not genuine:
        raise ValueError("calibrate needs genuine exemplars")
    if not impostors:
        raise ValueError("calibrate needs impostor negatives (E1)")

    reference = genuine + impostors
    scorer = CosineDeltaScorer.fit(genuine, reference, mfw_count)
    genuine_scores = [scorer.similarity(t) for t in genuine]
    impostor_scores = [scorer.similarity(t) for t in impostors]

    auc = round(
        roc_auc(genuine_scores + impostor_scores, [1] * len(genuine) + [0] * len(impostors)), 4
    )

    return {
        "register": register,
        "mfw_count": mfw_count,
        "scorer": scorer.to_dict(),
        "genuine_scores": genuine_scores,
        "impostor_scores": impostor_scores,
        "targets": features.compute_targets(genuine),
        "metrics": {
            # roc_auc and the flag use the same rounded value so they never disagree.
            "roc_auc": auc,
            "n_genuine": len(genuine),
            "n_impostor": len(impostors),
            "low_separation": auc < MIN_SEPARATION_AUC,
        },
    }
