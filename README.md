# mcp-voice

An MCP server that lets Claude **generate, rewrite, de-AI, and transform** written text so it
reads as a specific **human voice** — primarily the operator's own, extensible to other
**authorized** voices. Not for impersonating arbitrary third parties.

## Status

Early build. Specs (research-backed, decisions resolved) live in the `system` repo:

- `voice-mcp-research.md` — verified research + the three architecture calls
- `voice-mcp-spec-00-benchmark-spike.md` — calibration spike (prerequisite)
- `voice-mcp-spec-01-ingestion.md` — corpus ingestion ← **building now**
- `voice-mcp-spec-02-storage.md` — `voice.` schema + dual embeddings
- `voice-mcp-spec-03-eval-harness.md` — stylometric + detector gates (Python sidecar)
- `voice-mcp-spec-04-voice-model.md` — the generation engine
- `voice-mcp-spec-05-de-ai.md` — tell registry + surgical remediation
- `voice-mcp-spec-06-mcp-design.md` — the 7-tool MCP surface

## Architecture (locked)

- **Stack:** TypeScript MCP server (this repo) + a Python FastAPI eval sidecar over HTTP.
- **Storage:** reuse the Second Brain Postgres + pgvector in an isolated `voice.` schema.
- **Capture:** hybrid — distilled style card + style-coverage few-shot exemplars + RAG for facts.
- **Gate:** stylometric similarity is primary; AI-detectors are advisory-only (never optimized against).

## Toolchain

Bun + TypeScript, Biome, knip, `bun test`.

```sh
bun install
bun test
bun run quality   # biome ci + knip + tsc
```
