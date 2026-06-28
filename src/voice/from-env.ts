/**
 * Live construction of the VoiceEngine (spec 06 §3) — the wiring tail that assembles
 * every real dependency from the environment. Construction-only: it touches getDb(),
 * the Anthropic SDK, the eval sidecar, and Ollama, so it can't be unit-tested (the
 * engine LOGIC it builds is tested via createVoiceEngine with injected fakes). tsc
 * verifies it compiles against every seam.
 *
 * Reuses the existing infra (operator-confirmed): the NUC second_brain Postgres
 * (voice. schema), the Mac Mini nomic-embed-text endpoint, the eval sidecar. Needs
 * ANTHROPIC_API_KEY + DB_PASSWORD (env or /secrets) in the environment.
 *
 * Corpus is a prepared file (Slack + Claude chat, out-of-band); the server can't reach
 * Nextcloud/transcripts at runtime. voice_add's `sources` is unused by the file source
 * in v1 (the file IS the corpus) — a caller still passes a dummy source to satisfy the
 * schema until the live email/matrix adapters land.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "../db";
import { createExemplarStore } from "../exemplar-store";
import { createProfileStore } from "../profile-store";
import { type ClaudeClient, createClaudeGenerator } from "./claude-client";
import { createBuildVoice } from "./build-voice";
import { type BuildProfileDeps, createHybridImpostorSource } from "./build-profile";
import { createFileCorpusSource } from "./corpus-file";
import { createClaudeRhythmRewriter } from "./deai/rhythm";
import { createOtherAuthorsSource, createProfileDirectory } from "./directory";
import { createNomicEmbedders } from "./embedder-ollama";
import { createInMemoryJobStore, createVoiceEngine } from "./engine";
import { createEvalClient } from "./eval-client";
import { createClaudeProseExtractor } from "./prose-extractor";
import type { VoiceEngine } from "./mcp/tools";
import { createStorageExemplarSource, createStorageProfileSource } from "./storage-adapters";

const DEFAULT_EVAL_URL = "http://127.0.0.1:8920";
// The Mac Mini Ollama the Second Brain already runs (operator-confirmed); overridable.
const DEFAULT_OLLAMA_URL = "http://172.16.10.50:11434";
const DEFAULT_CORPUS_PATH = "/srv/mcp-voice/corpus/operator.json";
const INGEST_VERSION = "1";
const SECRETS_DIR = process.env["SECRETS_DIR"] ?? "/secrets";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

/**
 * Resolve the Anthropic API key the same way the DB password is resolved: the
 * `ANTHROPIC_API_KEY` env wins (local/CI), else the mounted secret file (the fleet's
 * file-based-secrets policy — no secrets in compose env). Errors are generic — they
 * never echo the path or value.
 */
function getAnthropicKey(): string {
  const fromEnv = process.env["ANTHROPIC_API_KEY"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const key = readFileSync(resolve(SECRETS_DIR, "anthropic-key"), "utf-8").trim();
    if (key.length === 0) {
      throw new Error("Key file is empty");
    }
    return key;
  } catch {
    throw new Error("Failed to load Anthropic key. Set ANTHROPIC_API_KEY or mount the secret.");
  }
}

/** Construct the live VoiceEngine from the environment + existing infra. */
export function createVoiceEngineFromEnv(): VoiceEngine {
  const sql = getDb();
  const claude = new Anthropic({ apiKey: getAnthropicKey() }) as unknown as ClaudeClient;
  const embedders = createNomicEmbedders({ baseUrl: env("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL) });
  const evalClient = createEvalClient({ baseUrl: env("EVAL_HARNESS_URL", DEFAULT_EVAL_URL) });

  const exemplarStore = createExemplarStore({ sql, embedders });
  const profileStore = createProfileStore({ sql });

  const buildProfile: BuildProfileDeps = {
    exemplars: exemplarStore,
    calibrator: evalClient,
    prose: createClaudeProseExtractor({ client: claude }),
    impostors: createHybridImpostorSource({ otherAuthors: createOtherAuthorsSource({ sql }) }),
    profiles: profileStore,
  };

  const voiceBuilder = createBuildVoice({
    corpus: createFileCorpusSource({ path: env("CORPUS_PATH", DEFAULT_CORPUS_PATH) }),
    buildProfile,
    ingestVersion: INGEST_VERSION,
    newVersion: () => randomUUID(),
    now: () => new Date().toISOString(),
  });

  return createVoiceEngine({
    generate: {
      generator: createClaudeGenerator({ client: claude }),
      evaluator: evalClient,
      exemplars: createStorageExemplarSource(exemplarStore),
      profiles: createStorageProfileSource(profileStore),
    },
    // de-AI: content embedder backs the meaning guard; rhythm pass at strict. Gate-B
    // detector deferred (no model wired) — stays advisory-absent.
    deai: { embedder: embedders.content, rhythm: createClaudeRhythmRewriter({ client: claude }) },
    directory: createProfileDirectory({ sql }),
    jobs: createInMemoryJobStore(),
    // The job only tracks success/failure; discard the build result → Promise<void>.
    buildVoice: async (input) => {
      await voiceBuilder(input);
    },
  });
}
