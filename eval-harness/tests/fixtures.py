"""Deterministic synthetic corpora: casual 'genuine' vs formal 'impostor' (shared
topic words → separation is style). Mirrors the spike's approach."""

import random

GEN = ["i", "really", "just", "gonna", "yeah", "kinda", "honestly", "like", "so", "but"]
IMP = ["however", "therefore", "moreover", "thus", "hence", "whilst", "albeit", "wherein"]
CONTENT = [
    "report",
    "deploy",
    "plan",
    "review",
    "build",
    "config",
    "module",
    "service",
    "ticket",
    "branch",
]


def _doc(palette, rng, sentences=10):
    out = []
    for _ in range(sentences):
        words = []
        for _ in range(rng.randint(6, 9)):
            words.append(rng.choice(palette) if rng.random() < 0.5 else rng.choice(CONTENT))
        out.append(" ".join(words))
    return ". ".join(out) + "."


def corpora(seed=3, n=18):
    rng = random.Random(seed)
    genuine = [_doc(GEN, rng) for _ in range(n)]
    impostors = [_doc(IMP, rng) for _ in range(n)]
    return genuine, impostors
