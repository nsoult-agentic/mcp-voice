from evalharness import calibration, gate
from tests.fixtures import corpora


def _profile():
    genuine, impostors = corpora()
    return calibration.calibrate(genuine, impostors, "email", mfw_count=100), genuine, impostors


def test_genuine_passes_and_no_impostor_leaks_to_pass():
    profile, genuine, impostors = _profile()
    gv = [gate.evaluate(t, profile, "email", "normal")["verdict"] for t in genuine]
    iv = [gate.evaluate(t, profile, "email", "normal")["verdict"] for t in impostors]
    # Genuine exemplars sit high in the combined distribution → PASS.
    assert sum(v == "PASS" for v in gv) / len(gv) >= 0.8
    # No impostor is ACCEPTED — borderline ones land in REVIEW (abstain band), the
    # clear ones FAIL; either way none reach PASS.
    assert sum(v == "PASS" for v in iv) == 0
    assert sum(v == "FAIL" for v in iv) / len(iv) >= 0.4  # a substantial chunk hard-fails


def test_short_text_is_review_never_confident():
    profile, _, _ = _profile()
    v = gate.evaluate("just shipped it", profile, "email", "normal")  # < 20 words
    assert v["verdict"] == "REVIEW"


def test_gate_b_never_turns_a_pass_into_fail():
    # Property (spec §10): whenever Gate A passes, the verdict is PASS or REVIEW,
    # never FAIL — Gate B can only ever downgrade, never fail on its own.
    profile, genuine, impostors = _profile()
    for t in genuine + impostors:
        v = gate.evaluate(t, profile, "email", "normal")
        if v["gate_a"]["passed"]:
            assert v["verdict"] in ("PASS", "REVIEW")


def test_gate_b_abstains_below_length_floor():
    profile, genuine, _ = _profile()
    v = gate.evaluate(genuine[0], profile, "email", "normal")
    assert v["gate_b"]["abstained"] is True  # synthetic docs are < 250 words
    assert v["gate_b"]["flag"] == "none"


def test_strictness_raises_the_bar():
    profile, genuine, _ = _profile()
    lenient = gate.evaluate(genuine[0], profile, "email", "lenient")
    strict = gate.evaluate(genuine[0], profile, "email", "strict")
    assert lenient["gate_a"]["threshold_percentile"] < strict["gate_a"]["threshold_percentile"]
