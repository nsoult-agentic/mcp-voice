/**
 * VoiceEngine implementation (spec 06 §3) — the orchestration glue that turns the
 * MCP tool calls into engine calls and maps engine results to the `structuredContent`
 * gate contract (§5). All sub-dependencies are INJECTED, so this logic is unit-tested
 * without a live API/sidecar/DB; `createVoiceEngineFromEnv` (separate, live-only) does
 * the real construction.
 *
 * - generate / rewrite / transform all funnel through the gated loop (generateInVoice),
 *   differing only in the task framing; rewrite/transform add a meaning-preservation
 *   check (input → output) on top of the voice gate.
 * - deai funnels through the de-AI pipeline (voiceless by default).
 * - voice_add is an app-level job (M1): returns a job_id immediately, runs the build in
 *   the background, and voice_status polls readiness. `failed_checks` carry check IDs
 *   only — never corpus text (boundary isolation, §8).
 */
import type { Register } from "../corpus-record";
import { checkMeaning, type MeaningEmbedder } from "./deai/meaning-guard";
import { type DeaiDeps, deAI, type DeaiStrictness } from "./deai/deai";
import { type GenerateDeps, generateInVoice, type GenerateResult } from "./generate";
import type {
  DeaiResult,
  GateResult,
  VoiceAddResult,
  VoiceListResult,
  VoiceStatusResult,
} from "./mcp/schemas";
import type {
  voiceAddInput,
  voiceDeaiInput,
  voiceGenerateInput,
  voiceRewriteInput,
  voiceStatusInput,
  voiceTransformInput,
} from "./mcp/schemas";
import type { VoiceEngine } from "./mcp/tools";
import type { Strictness, Verdict } from "./types";
import type { z } from "zod";

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Gate-B flag → an advisory detector probability (Gate B deferred ⇒ "none" ⇒ 0). */
function gateBProb(flag: Verdict["gate_b"]["flag"]): number {
  return flag === "high" ? 0.85 : flag === "low" ? 0.4 : 0;
}

/** MCP strictness {lenient,standard,strict} → voice-model gate {lenient,normal,strict}. */
function toGateStrictness(s: "lenient" | "standard" | "strict" | undefined): Strictness {
  return s === "standard" ? "normal" : (s ?? "normal");
}

/** Map a gated-generation result to the MCP gate contract (§5). check IDs only. */
function toGateResult(
  r: GenerateResult,
  voice_id: string,
  register: Register,
  extraFailed: string[] = [],
): GateResult {
  const failed = [...extraFailed];
  if (!r.verdict.gate_a.passed) failed.push("gate_a");
  if (r.verdict.gate_b.flag === "high") failed.push("gate_b");
  if (r.cold_start) failed.push("cold_start");
  const verdict =
    extraFailed.length > 0 && r.verdict.verdict === "PASS" ? "REVIEW" : r.verdict.verdict;
  return {
    text: r.candidate,
    verdict,
    scores: {
      stylometric_similarity: clamp01(r.verdict.gate_a.percentile),
      ai_detector_prob: gateBProb(r.verdict.gate_b.flag),
      // register_fit: no separate cross-register signal yet — mirror Gate A for now.
      register_fit: clamp01(r.verdict.gate_a.percentile),
    },
    gate: { passed: failed.length === 0, failed_checks: failed },
    register,
    voice_id,
  };
}

export type JobStatus = "running" | "succeeded" | "failed";

/** App-level job store for voice_add (M1) — no dependency on experimental MCP Tasks. */
export interface JobStore {
  create(): string;
  markSucceeded(jobId: string): void;
  markFailed(jobId: string, error: string): void;
  get(jobId: string): { status: JobStatus; error?: string } | null;
}

/** Default in-process job store (M1). Real deployments can swap a DB-backed one. */
export function createInMemoryJobStore(): JobStore {
  let n = 0;
  const jobs = new Map<string, { status: JobStatus; error?: string }>();
  return {
    create(): string {
      n += 1;
      const id = `job_${n}`;
      jobs.set(id, { status: "running" });
      return id;
    },
    markSucceeded(jobId: string): void {
      const job = jobs.get(jobId);
      if (job) job.status = "succeeded";
    },
    markFailed(jobId: string, error: string): void {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = error;
      }
    },
    get(jobId: string): { status: JobStatus; error?: string } | null {
      return jobs.get(jobId) ?? null;
    },
  };
}

/** Per-voice readiness directory (storage-backed in the live wiring). */
export interface ProfileDirectory {
  listVoices(): Promise<VoiceListResult>;
  voiceStatus(voice_id: string): Promise<VoiceStatusResult>;
}

export interface EngineDeps {
  generate: GenerateDeps;
  deai: DeaiDeps & { embedder?: MeaningEmbedder };
  directory: ProfileDirectory;
  jobs: JobStore;
  /** The full voice build (ingest → store → profile, M2). Impl is the live tail. */
  buildVoice(input: z.infer<typeof voiceAddInput>): Promise<void>;
}

const REWRITE_TASK = (text: string): string =>
  `Rewrite the message below in the author's voice. Keep its meaning, facts, names, and numbers intact.\n\n${text}`;
const TRANSFORM_TASK = (text: string): string =>
  `Rewrite the message below in the target author's voice. Keep its meaning, facts, names, and numbers intact.\n\n${text}`;

export function createVoiceEngine(deps: EngineDeps): VoiceEngine {
  /** Shared meaning check for rewrite/transform: input → output must preserve content. */
  async function withMeaning(text: string, r: GenerateResult): Promise<string[]> {
    const meaning = await checkMeaning(text, r.candidate, { embedder: deps.deai.embedder });
    return meaning.ok ? [] : ["meaning"];
  }

  return {
    async generate(input: z.infer<typeof voiceGenerateInput>): Promise<GateResult> {
      const r = await generateInVoice(deps.generate, {
        author_id: input.voice_id,
        register: input.register,
        task: input.brief,
        strictness: toGateStrictness(undefined),
        ...(input.knobs?.grounding_query ? { groundingQuery: input.knobs.grounding_query } : {}),
      });
      return toGateResult(r, input.voice_id, input.register);
    },

    async rewrite(input: z.infer<typeof voiceRewriteInput>): Promise<GateResult> {
      const r = await generateInVoice(deps.generate, {
        author_id: input.voice_id,
        register: input.register,
        task: REWRITE_TASK(input.text),
        strictness: toGateStrictness(input.strictness),
      });
      return toGateResult(r, input.voice_id, input.register, await withMeaning(input.text, r));
    },

    async transform(input: z.infer<typeof voiceTransformInput>): Promise<GateResult> {
      const r = await generateInVoice(deps.generate, {
        author_id: input.to_voice, // target voice drives generation; from_voice is informational
        register: input.register,
        task: TRANSFORM_TASK(input.text),
        strictness: toGateStrictness(undefined),
      });
      return toGateResult(r, input.to_voice, input.register, await withMeaning(input.text, r));
    },

    async deai(input: z.infer<typeof voiceDeaiInput>): Promise<DeaiResult> {
      const before = deps.deai.detector ? await deps.deai.detector.score(input.text) : 0;
      const r = await deAI(
        input.text,
        {
          register: input.register,
          strictness: (input.strictness ?? "standard") as DeaiStrictness,
        },
        deps.deai,
      );
      const after = r.detector_score ?? 0;
      const failed = [
        ...r.residual_tells.map((t) => t.id),
        ...r.meaning_breaches.map(() => "meaning"),
      ];
      return {
        text: r.text,
        verdict: r.verdict,
        scores: {
          // voiceless de-AI has no stylometric anchor; report the detector + a neutral fit.
          stylometric_similarity: 0,
          ai_detector_prob: clamp01(after),
          register_fit: 1,
        },
        gate: { passed: r.verdict === "PASS", failed_checks: failed },
        register: input.register,
        voice_id: input.voice_id ?? "",
        ai_detector_prob_before: clamp01(before),
        ai_detector_prob_after: clamp01(after),
      };
    },

    async addVoice(input: z.infer<typeof voiceAddInput>): Promise<VoiceAddResult> {
      const jobId = deps.jobs.create();
      // Fire-and-forget: the build runs in the background; voice_status polls readiness.
      deps
        .buildVoice(input)
        .then(() => deps.jobs.markSucceeded(jobId))
        .catch((err: unknown) =>
          deps.jobs.markFailed(jobId, err instanceof Error ? err.message : String(err)),
        );
      return { job_id: jobId };
    },

    listVoices(): Promise<VoiceListResult> {
      return deps.directory.listVoices();
    },

    voiceStatus(input: z.infer<typeof voiceStatusInput>): Promise<VoiceStatusResult> {
      return deps.directory.voiceStatus(input.voice_id);
    },
  };
}
