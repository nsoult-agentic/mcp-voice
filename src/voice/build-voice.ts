/**
 * buildVoice (spec 06 M2) — the full "build a voice" pipeline behind voice_add:
 *
 *   corpus pull → ingestion pipeline → store exemplars → per-register profile build
 *
 * This is the orchestration the async voice_add job runs. Dependencies are injected
 * (the corpus source, the stores, the calibrate/prose/impostor deps), so the flow is
 * unit-testable without a live API/sidecar/DB; the from-env wiring supplies the real
 * ones. A register too thin to calibrate (< MIN_EXEMPLARS) is skipped as cold-start —
 * it doesn't fail the whole build.
 *
 * Partial progress on failure: registers activate as they build, so a non-cold-start
 * error mid-loop rethrows (marking the voice_add job failed) while earlier registers
 * stay live. This is recoverable — re-running is idempotent on exemplars and rebuilds
 * produce fresh versions — but the job's "failed" can coexist with some registers ready.
 */
import type { z } from "zod";
import { runPipeline } from "../pipeline";
import type { RawUnit } from "../adapters/raw-unit";
import {
  type BuildProfileDeps,
  buildRegisterProfile,
  InsufficientCorpusError,
} from "./build-profile";
import type { voiceAddInput } from "./mcp/schemas";

/** Supplies the operator's own authored raw units for a voice (Slack, Claude chat, …). */
export interface CorpusSource {
  pull(input: z.infer<typeof voiceAddInput>): Promise<RawUnit[]>;
}

export interface BuildVoiceDeps {
  corpus: CorpusSource;
  /** Shared with the store the profile build reads from (same instance). */
  buildProfile: BuildProfileDeps;
  ingestVersion: string;
  newVersion: () => string; // immutable profile version id (caller-stamped)
  now: () => string; // ISO timestamp (caller-stamped — keeps this pure/testable)
}

export interface BuildVoiceResult {
  ingested: number;
  builtRegisters: string[];
  skippedRegisters: string[];
}

/** Create the voice_add build pipeline over injected deps. */
export function createBuildVoice(
  deps: BuildVoiceDeps,
): (input: z.infer<typeof voiceAddInput>) => Promise<BuildVoiceResult> {
  return async (input) => {
    const units = await deps.corpus.pull(input);
    const records = runPipeline(units, { ingest_version: deps.ingestVersion });
    await deps.buildProfile.exemplars.upsert(records);

    const registers = [...new Set(records.map((r) => r.register))];
    const builtRegisters: string[] = [];
    const skippedRegisters: string[] = [];
    for (const register of registers) {
      try {
        await buildRegisterProfile(deps.buildProfile, {
          author_id: input.voice_id,
          register,
          version: deps.newVersion(),
          builtAt: deps.now(),
        });
        builtRegisters.push(register);
      } catch (err) {
        if (err instanceof InsufficientCorpusError) {
          skippedRegisters.push(register); // thin register → cold-start, not a failure
          continue;
        }
        throw err;
      }
    }
    return { ingested: records.length, builtRegisters, skippedRegisters };
  };
}
