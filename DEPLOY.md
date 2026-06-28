# Deploying mcp-voice

mcp-voice generates / rewrites / de-AIs / transforms text in the operator's voice.
It is two containers that **run on the NUC** (the `voice.` schema lives in the
second_brain Postgres, reachable only on that host / the `second-brain` docker
network):

| Container        | Image                                   | Port            | Role                                   |
| ---------------- | --------------------------------------- | --------------- | -------------------------------------- |
| `mcp-voice`      | `ghcr.io/nsoult-agentic/mcp-voice`      | `127.0.0.1:8919`| TS MCP server (Streamable HTTP)        |
| `mcp-voice-eval` | `ghcr.io/nsoult-agentic/mcp-voice-eval` | internal only   | Python FastAPI Gate-A stylometry sidecar |

```
Mac Mini (Claude Desktop, 172.16.10.50)
        │  HTTPS
        ▼
   NPM reverse proxy ──(X-Forwarded-For)──► mcp-voice:8919 /mcp
                                               │   ├─► second-brain-db:5432   (voice. schema)
                                               │   ├─► mcp-voice-eval:8920    (Gate A)
                                               │   └─► 172.16.10.50:11434     (Ollama nomic-embed-text)
                                               └─► api.anthropic.com          (generation)
```

## Prerequisites (on the NUC)

1. **Secrets** — root-owned, `0400`, under `/srv/mcp-voice/secrets/` (mounted read-only
   at `/secrets`; read directly from file, never via compose env):
   - `anthropic-key` — the Anthropic API key.
   - `db-password` — the `voice_rw` role password.
2. **Corpus** — the prepared corpus at `/srv/mcp-voice/corpus/operator.json`
   (see [Corpus](#corpus)). Directory readable by the container (uid 1000 / bun).
3. **Networks** — both already exist on the NUC:
   - `mcp_network` (external) — the proxy + inter-service network.
   - `second-brain` (external, referenced as `brain`) — the Postgres network.

## One-time database bootstrap

Run once, as superuser, before the first deploy. Creates the `voice_rw` role, the
isolated `voice.` schema it owns, and the shared `vector` extension:

```bash
psql -h 127.0.0.1 -U pai -d second_brain \
     -v voice_pw="$(sudo cat /srv/mcp-voice/secrets/db-password)" \
     -f ops/bootstrap.sql
```

The app never touches the knowledge tables — `voice_rw` owns only `voice.`.

## Deploy (Portainer GitOps)

1. Merge to `main`. The `Build mcp-voice` workflow builds **both** images, pushes
   them to ghcr.io, and rewrites the image tags in `docker-compose.yml`.
2. Portainer → **Stacks → Add from repository** → this repo, `docker-compose.yml`,
   GitOps polling on. (Existing stack: it re-pulls on the tag bump.)

The Anthropic key and DB password are read from the mounted `/secrets` files at
startup — no stack env vars needed for either.

### Security preconditions (verify before exposing)

These are load-bearing — the `/mcp` IP allowlist only holds if both are true:

- **Loopback-scoped publish.** The compose publishes `127.0.0.1:8919:8919`. Never
  change it to `8919:8919` (that would expose `/mcp` to the whole LAN, where a
  request with no `X-Forwarded-For` is treated as trusted loopback).
- **Proxy overwrites XFF.** The NPM proxy must set
  `proxy_set_header X-Forwarded-For $remote_addr` (overwrite), **not**
  `$proxy_add_x_forwarded_for` (append). The gate trusts the first XFF hop; appending
  would let a client spoof it. This matches the rest of the fleet (mcp-accounting/
  mcp-email) — it is a shared proxy decision.

## First run

```bash
# 1. Create the voice. tables + indexes (idempotent).
docker exec mcp-voice bun run migrate

# 2. Build the operator's profile from the corpus. Via the MCP client, call:
#       voice_add  { voice_id: "operator", sources: [<any dummy — the file IS the corpus>] }
#    then poll voice_status { voice_id: "operator" } until the registers report ready.
#    (Ingest → store → calibrate → build profile runs as an app-level job.)

# 3. Smoke test: one real generation round-trip.
#       voice_generate { voice_id: "operator", register: "longform", task: "..." }
#    Confirm the returned verdict + text look right.
```

### Cost probe ($0)

Before turning generation loose, confirm token accounting with a count-only call
(`messages.count_tokens` bills nothing) to size a typical generate prompt. Do this
from a scratch script against the same model (`claude-opus-4-8`) and the assembled
prompt; it returns input-token counts without generating.

## Operational notes

- **Health:** `curl http://127.0.0.1:8919/health` → `{"status":"ok","service":"mcp-voice"}`.
  The sidecar's `/health` is internal (no host port).
- **`voice_add` jobs are in-memory (v1).** A container restart loses in-flight job
  state; `voice_status` for a pre-restart job won't find it. The *profiles* persist
  in Postgres, so readiness is still observable — just re-run `voice_add` if a build
  was interrupted by a restart.
- **Rate limit:** 120 `/mcp` requests/min (coarse global backstop). The IP allowlist
  bounds *who* can call; it does not cap per-request Claude spend.
- **Local dev:** `bun run start` serves HTTP; `bun run src/main.ts` serves stdio.
  Both need `DB_PASSWORD` (or the mounted secret) + a reachable DB/sidecar/Ollama.

## Corpus

`operator.json` is a JSON array of the operator's own authored text. Each entry:

```json
{
  "medium": "slack",                         // "slack" | "claude" | "email" | "matrix"
  "source_uri": "slack://fe-devs/p1700000000",
  "timestamp": "2026-06-01T12:00:00.000Z",   // ISO-8601 datetime
  "text": "the operator's verbatim message"
}
```

`slack` → longform register, `claude` → chat register (no boundary-strip is applied
to these pre-cleaned mediums; provenance is carried by `source_uri`). Third-party
text must never appear — operator's substantive turns only.
