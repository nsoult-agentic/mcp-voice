import importlib

import pytest
from fastapi.testclient import TestClient

from tests.fixtures import corpora


@pytest.fixture
def client():
    # Fresh app module per test so the in-memory profile cache doesn't leak.
    from evalharness import app as app_module

    importlib.reload(app_module)
    return TestClient(app_module.app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_evaluate_before_calibrate_is_404(client):
    r = client.post(
        "/evaluate", json={"text": "hi there friends", "author_id": "operator", "register": "email"}
    )
    assert r.status_code == 404


def test_calibrate_then_evaluate_roundtrip(client):
    genuine, impostors = corpora()
    cal = client.post(
        "/calibrate",
        json={
            "author_id": "operator",
            "register": "email",
            "genuine": genuine,
            "impostors": impostors,
            "mfw_count": 100,
        },
    )
    assert cal.status_code == 200
    body = cal.json()
    assert body["metrics"]["roc_auc"] >= 0.85  # separable synthetic
    assert "scorer" in body and "targets" in body

    g = client.post(
        "/evaluate", json={"text": genuine[0], "author_id": "operator", "register": "email"}
    )
    assert g.status_code == 200
    assert g.json()["verdict"] == "PASS"

    # No impostor is accepted (PASS); they FAIL or land in REVIEW.
    verdicts = [
        client.post(
            "/evaluate", json={"text": t, "author_id": "operator", "register": "email"}
        ).json()["verdict"]
        for t in impostors
    ]
    assert sum(v == "PASS" for v in verdicts) == 0


def test_seed_restores_calibration_after_restart(client):
    genuine, impostors = corpora()
    blob = client.post(
        "/calibrate",
        json={
            "author_id": "operator",
            "register": "email",
            "genuine": genuine,
            "impostors": impostors,
            "mfw_count": 100,
        },
    ).json()

    # Simulate a sidecar restart: a fresh app with an empty in-memory cache.
    from evalharness import app as app_module

    importlib.reload(app_module)
    fresh = TestClient(app_module.app)

    evaluate_body = {"text": genuine[0], "author_id": "operator", "register": "email"}
    assert fresh.post("/evaluate", json=evaluate_body).status_code == 404  # cache wiped

    seeded = fresh.post(
        "/seed", json={"author_id": "operator", "register": "email", "blob": blob}
    )
    assert seeded.status_code == 200
    assert seeded.json()["seeded"] is True

    # Re-seeded from the persisted blob → /evaluate works again without a rebuild.
    g = fresh.post("/evaluate", json=evaluate_body)
    assert g.status_code == 200
    assert g.json()["verdict"] == "PASS"


def test_bad_register_is_422(client):
    r = client.post("/evaluate", json={"text": "x", "author_id": "operator", "register": "sms"})
    assert r.status_code == 422


def test_style_embed_deferred_501(client):
    assert client.post("/style-embed").status_code == 501


def test_features_endpoint(client):
    r = client.post("/features", json={"text": "Hey — I'll just ship it 🙂. it works."})
    assert r.status_code == 200
    assert r.json()["emoji_rate"] > 0
