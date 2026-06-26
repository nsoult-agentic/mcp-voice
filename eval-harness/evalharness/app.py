"""FastAPI eval-harness sidecar (spec 03 §4).

Local-loopback service the TS MCP calls. Persistent (E3): profiles are calibrated
once and cached in-memory keyed by (author_id, register); `/calibrate` also returns
the blob so `storage` can persist it into voice.profiles and re-seed on restart.

Slice 1: Gate A (Cosine-Delta) + calibrate + features + health. Gate B (Binoculars)
and `/style-embed` (StyleDistance) are deferred seams.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from . import calibration, features, gate
from .models import CalibrateRequest, EvaluateRequest, FeaturesRequest

app = FastAPI(title="voice-eval-harness", version="0.1.0")

# In-memory profile cache: (author_id, register) -> calibration blob.
_PROFILES: dict[tuple[str, str], dict] = {}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "profiles_loaded": len(_PROFILES)}


@app.post("/calibrate")
def calibrate(req: CalibrateRequest) -> dict:
    try:
        blob = calibration.calibrate(req.genuine, req.impostors, req.register, req.mfw_count)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    _PROFILES[(req.author_id, req.register)] = blob
    return blob


@app.post("/evaluate")
def evaluate(req: EvaluateRequest) -> dict:
    profile = _PROFILES.get((req.author_id, req.register))
    if profile is None:
        # No register-matched profile → cannot score (spec §12.5: never cross-score).
        raise HTTPException(
            status_code=404,
            detail=f"no calibrated profile for ({req.author_id}, {req.register}); calibrate first",
        )
    return gate.evaluate(req.text, profile, req.register, req.strictness)


@app.post("/features")
def features_endpoint(req: FeaturesRequest) -> dict:
    return features.compute_targets([req.text])


@app.post("/style-embed", status_code=501)
def style_embed() -> dict:
    # Deferred: the spike showed Cosine-Delta carries separation; StyleDistance's
    # marginal value is unproven. Clean seam to add later.
    raise HTTPException(status_code=501, detail="style-embed deferred (StyleDistance not wired)")
