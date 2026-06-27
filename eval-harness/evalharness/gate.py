"""The gate (spec 03 §6, §7, §10) — Gate A (primary) + Gate B (advisory) → verdict.

Spike amendments folded in:
- Gate A is Cosine-Delta only for now (the spike-validated separator); StyleDistance
  `style_cosine` is a clean seam, currently null.
- Gate B (local Binoculars) is deferred; it always abstains/`none` here. The verdict
  logic still encodes the locked rule: Gate B NEVER gates a PASS into a FAIL on its
  own — at most it downgrades PASS→REVIEW (spec §7, §10).
- Gate is advisory-permissive (spike: the stylometric gate is an imperfect proxy for
  the operator's judgment, which is the final authority).
"""

from __future__ import annotations

from .features import word_count
from .stylometry import CosineDeltaScorer

# strictness → Gate-A percentile floor (spec §6).
STRICTNESS_PERCENTILE = {"lenient": 0.25, "normal": 0.40, "strict": 0.60}
# Borderline band around the threshold → REVIEW (spec §10).
ABSTAIN_BAND = 0.10
# Below this, stylometry can't judge confidently → REVIEW (spec §10 length floor).
GATE_A_MIN_WORDS = 20
# Below this, the AI detector abstains (spec §7); detectors are unreliable on short text.
GATE_B_MIN_WORDS = 250


def _combined_percentile(score: float, genuine: list[float], impostor: list[float]) -> float:
    """Rank of the candidate within the combined author-vs-impostor score
    distribution (spec §6). Genuine exemplars cluster high, impostors low, so a
    high percentile means 'sits up among the genuine, above the impostors.'"""
    alls = genuine + impostor
    if not alls:
        return 0.0
    return sum(1 for s in alls if score >= s) / len(alls)


def evaluate(text: str, profile: dict, register: str, strictness: str = "normal") -> dict:
    if strictness not in STRICTNESS_PERCENTILE:
        raise ValueError(f"unknown strictness: {strictness}")

    wc = word_count(text)
    scorer = CosineDeltaScorer.from_dict(profile["scorer"])
    score = scorer.similarity(text)
    percentile = _combined_percentile(score, profile["genuine_scores"], profile["impostor_scores"])
    threshold = STRICTNESS_PERCENTILE[strictness]

    passed = percentile >= threshold
    borderline = abs(percentile - threshold) <= ABSTAIN_BAND
    # A profile that doesn't separate the author from impostors makes the percentile
    # meaningless — never confidently PASS against it (build-phase guard).
    low_separation = bool(profile.get("metrics", {}).get("low_separation", False))

    # Gate B (advisory) — deferred detector: abstains; never high here.
    gate_b = {
        "flag": "none",
        "detector_score": None,
        "abstained": wc < GATE_B_MIN_WORDS,
        "note": "advisory; detector deferred (slice 1); never gates a PASS by itself",
    }

    if wc < GATE_A_MIN_WORDS:
        verdict = "REVIEW"  # too short to judge confidently
    elif borderline:
        verdict = "REVIEW"
    elif passed:
        # Gate B high OR an unreliable (low-separation) profile downgrades PASS→REVIEW.
        verdict = "REVIEW" if (gate_b["flag"] == "high" or low_separation) else "PASS"
    else:
        verdict = "FAIL"

    return {
        "verdict": verdict,
        "gate_a": {
            "passed": passed,
            "cosine_delta": round(score, 4),
            "style_cosine": None,  # StyleDistance seam (deferred)
            "percentile": round(percentile, 4),
            "threshold_percentile": threshold,
            "low_separation": low_separation,
        },
        "gate_b": gate_b,
        "register": register,
        "word_count": wc,
    }
