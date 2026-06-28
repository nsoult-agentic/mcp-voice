"""HTTP contract models (spec 03 §4)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Register = Literal["chat", "email", "longform"]
Strictness = Literal["lenient", "normal", "strict"]


class CalibrateRequest(BaseModel):
    author_id: str
    register: Register
    genuine: list[str] = Field(min_length=1)
    impostors: list[str] = Field(min_length=1)  # AI + other-humans combined (E1)
    mfw_count: int = 200


class EvaluateRequest(BaseModel):
    text: str
    author_id: str
    register: Register
    strictness: Strictness = "normal"


class FeaturesRequest(BaseModel):
    text: str


class SeedRequest(BaseModel):
    """Re-seed an in-memory calibration from a previously persisted /calibrate blob.

    Lets the TS server restore the sidecar's cache after a restart without re-running
    the full calibration (the blob lives in voice.profiles)."""

    author_id: str
    register: Register
    blob: dict
