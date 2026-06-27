/**
 * Live construction of the VoiceEngine (spec 06 §3) — the wiring tail.
 *
 * It assembles everything that ALREADY EXISTS and is tested (Postgres stores +
 * adapters, the eval-harness HTTP client, the Claude generator, the in-memory job
 * store) into a working generate/rewrite/transform/deai engine. The pieces that
 * are NOT built yet are taken as explicit parameters rather than fabricated:
 *   - `embedders` — no concrete embedder ships yet (pre-prod item);
 *   - `directory` — voice_list / voice_status need new storage queries;
 *   - `buildVoice` — voice_add's full ingest→store→build pipeline (M2).
 * Supply those and this returns a live engine. Requires ANTHROPIC_API_KEY, a running
 * eval-harness sidecar (EVAL_HARNESS_URL), and a Postgres/pgvector DB (getDb env).
 *
 * NOTE: this module is construction-only — it cannot be exercised without the live
 * services above, so it carries no unit tests (the engine LOGIC it builds is tested
 * via createVoiceEngine with injected fakes).
 */
import { getDb } from "../db";
import type { Embedders } from "../embedder";
import { createExemplarStore } from "../exemplar-store";
import { createProfileStore } from "../profile-store";
import { createClaudeGenerator } from "./claude-client";
import type { AiDetector, RhythmRewriter } from "./deai/deai";
import { createInMemoryJobStore, createVoiceEngine, type ProfileDirectory } from "./engine";
import { createEvalClient } from "./eval-client";
import type { VoiceEngine } from "./mcp/tools";
import type { voiceAddInput } from "./mcp/schemas";
import { createStorageExemplarSource, createStorageProfileSource } from "./storage-adapters";
import type { z } from "zod";

const DEFAULT_EVAL_URL = "http://localhost:8920";

export interface FromEnvDeps {
  /** No concrete embedder ships yet — caller supplies the content+style pair. */
  embedders: Embedders;
  /** voice_list / voice_status backing (new storage queries — live tail). */
  directory: ProfileDirectory;
  /** voice_add's full pipeline (ingest → store → per-register profile, M2). */
  buildVoice(input: z.infer<typeof voiceAddInput>): Promise<void>;
  /** Optional advisory AI detector (Gate B) and LLM rhythm rewrite (de-AI Pass 3). */
  detector?: AiDetector;
  rhythm?: RhythmRewriter;
}

/** Construct a live VoiceEngine from the environment + the not-yet-built pieces. */
export function createVoiceEngineFromEnv(deps: FromEnvDeps): VoiceEngine {
  const sql = getDb();
  const evalClient = createEvalClient({
    baseUrl: process.env["EVAL_HARNESS_URL"] ?? DEFAULT_EVAL_URL,
  });
  const generator = createClaudeGenerator(); // reads ANTHROPIC_API_KEY from env
  const exemplarStore = createExemplarStore({ sql, embedders: deps.embedders });
  const profileStore = createProfileStore({ sql });

  return createVoiceEngine({
    generate: {
      generator,
      evaluator: evalClient,
      exemplars: createStorageExemplarSource(exemplarStore),
      profiles: createStorageProfileSource(profileStore),
    },
    deai: {
      // The content embedder backs the de-AI meaning-preservation guard.
      embedder: deps.embedders.content,
      ...(deps.detector ? { detector: deps.detector } : {}),
      ...(deps.rhythm ? { rhythm: deps.rhythm } : {}),
    },
    directory: deps.directory,
    jobs: createInMemoryJobStore(),
    buildVoice: deps.buildVoice,
  });
}
