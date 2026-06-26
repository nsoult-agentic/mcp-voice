from evalharness import features


def test_compute_targets_shape_and_ranges():
    texts = [
        "Hey guys — I'll just push this tonight! it's a quick one 🙂",
        "However, the deployment requires careful review. Therefore we proceed.",
    ]
    t = features.compute_targets(texts)
    assert t["sentence_len_mean"] > 0
    assert 0.0 < t["mattr"] <= 1.0
    assert 0.0 <= t["lowercase_start_rate"] <= 1.0
    assert t["contraction_rate"] > 0  # "I'll", "it's"
    assert t["emoji_rate"] > 0  # 🙂
    assert t["punctuation_profile"]["em_dash"] > 0  # —
    assert t["word_count"] > 0 and t["sample_count"] == 2


def test_mattr_handles_short_and_long():
    assert features.mattr([]) == 0.0
    assert features.mattr(["a", "a", "b"]) == 2 / 3
    long = [f"w{i % 10}" for i in range(200)]  # 10 unique in any window of 50
    assert 0.0 < features.mattr(long, window=50) <= 0.2 + 1e-9


def test_signature_ngrams_are_frequent_repeated_phrases():
    texts = ["please make sure you build", "please make sure you test", "please make sure it works"]
    grams = features.signature_ngrams(texts)
    assert "please make sure" in grams


def test_word_count():
    assert features.word_count("one two three") == 3
    assert features.word_count("") == 0
