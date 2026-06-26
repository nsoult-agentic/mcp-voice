import pytest

from evalharness.stylometry import (
    CosineDeltaScorer,
    most_frequent_words,
    relative_frequencies,
    tokenize,
)
from tests.fixtures import corpora


def test_tokenize_keeps_contractions():
    assert tokenize("I'll Really go!") == ["i'll", "really", "go"]


def test_relative_frequencies():
    assert list(relative_frequencies("a a b", ["a", "b", "z"])) == [2 / 3, 1 / 3, 0.0]
    assert list(relative_frequencies("", ["a"])) == [0.0]


def test_mfw_orders_by_freq_then_alpha():
    assert most_frequent_words(["a a b b b c", "b a"], 3) == ["b", "a", "c"]


def test_fit_requires_inputs():
    with pytest.raises(ValueError):
        CosineDeltaScorer.fit([], ["ref"], 10)
    with pytest.raises(ValueError):
        CosineDeltaScorer.fit(["g"], [], 10)


def test_genuine_scores_above_impostor():
    genuine, impostors = corpora()
    scorer = CosineDeltaScorer.fit(genuine[:14], genuine[:14] + impostors, 100)
    g = sum(scorer.similarity(t) for t in genuine[14:]) / len(genuine[14:])
    i = sum(scorer.similarity(t) for t in impostors) / len(impostors)
    assert g > i


def test_round_trip_serialization():
    genuine, impostors = corpora()
    scorer = CosineDeltaScorer.fit(genuine, genuine + impostors, 50)
    restored = CosineDeltaScorer.from_dict(scorer.to_dict())
    assert restored.similarity(genuine[0]) == scorer.similarity(genuine[0])
