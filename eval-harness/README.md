# voice-eval-harness (spec 03)

The Voice MCP **Python sidecar** — the one Python component (stylometry lives in
Python; the MCP server stays TypeScript and calls this over local HTTP). Answers,
for any candidate text: *is this in the operator's voice?* → **PASS / REVIEW / FAIL**
plus every sub-score.

Lives as a subdir of mcp-voice but is a **separate runtime service** (own venv,
own CI). Reversible to its own repo at deploy time.

## Endpoints (spec 03 §4)

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /health` | ✅ | readiness + profiles loaded |
| `POST /calibrate` | ✅ | build author/register centroid + percentile thresholds from genuine + impostor negatives (E1); caches in-memory + returns the blob for `storage` to persist |
| `POST /evaluate` | ✅ | the gate — Gate A → verdict + sub-scores |
| `POST /features` | ✅ | StyleCard computed targets (spec 04 §4a) for a text |
| `POST /style-embed` | 🚧 501 | StyleDistance — deferred (spike: unproven marginal value) |

## Gates

- **Gate A (PRIMARY):** Cosine-Delta over MFW vs the register-matched author
  centroid, scored as a **percentile of the author-vs-impostor distribution**.
  `strictness` (lenient/normal/strict) → percentile floor (0.25 / 0.40 / 0.60).
- **Gate B (ADVISORY):** local AI detector — **deferred** (Binoculars not yet
  vendored). The verdict logic already enforces the locked rule: Gate B never
  fails a Gate-A pass on its own (at most PASS→REVIEW).
- **Verdict:** PASS / REVIEW (borderline abstain band, or text below the length
  floor, or Gate-B high) / FAIL. The operator's judgment is the final authority
  (spike: the gate is an imperfect proxy — kept advisory-permissive).

## Dev

```bash
cd eval-harness && python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && ruff format --check . && python -m pytest -q
uvicorn evalharness.app:app --port 8920   # run the service
```

## Deferred (later slices)

Gate B (vendored Binoculars), StyleDistance `/style-embed`, persistence wiring to
`storage` (re-seed profiles on restart), the richer §5 n-gram/char features for
the centroid (slice 1 Gate A uses Cosine-Delta MFW, which the spike validated).
