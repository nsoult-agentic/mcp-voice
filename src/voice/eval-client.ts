/**
 * eval-harness HTTP client (spec 04 wiring → spec 03 §4).
 *
 * Implements the injected `Evaluator` seam by calling the Python sidecar over
 * local HTTP. The sidecar response is VALIDATED with Zod at the boundary
 * (code-quality defer): the cross-language contract is checked at runtime, so a
 * drifted/renamed field fails loudly here instead of silently lying to the
 * generator.
 */
import { z } from "zod";
import type { Register } from "../corpus-record";
import type { Evaluator } from "./generate";
import type { Verdict } from "./types";

const RegisterSchema = z.enum(["chat", "email", "longform"]);

const VerdictSchema = z.object({
  verdict: z.enum(["PASS", "REVIEW", "FAIL"]),
  gate_a: z.object({
    passed: z.boolean(),
    cosine_delta: z.number(),
    style_cosine: z.number().nullable(),
    percentile: z.number(),
    threshold_percentile: z.number(),
  }),
  gate_b: z.object({ flag: z.enum(["none", "low", "high"]), abstained: z.boolean() }),
  register: RegisterSchema,
  word_count: z.number(),
});

const TargetsSchema = z.object({
  sentence_len_mean: z.number(),
  sentence_len_variance: z.number(),
  mattr: z.number(),
  punctuation_profile: z.record(z.string(), z.number()),
  contraction_rate: z.number(),
  emoji_rate: z.number(),
  lowercase_start_rate: z.number(),
  signature_ngrams: z.array(z.string()),
});

// The /calibrate blob: targets + metrics are read; scorer/scores are opaque and
// passed through to `storage` for persistence.
const CalibrateBlobSchema = z
  .object({
    register: RegisterSchema,
    targets: TargetsSchema,
    metrics: z.object({ roc_auc: z.number() }).passthrough(),
  })
  .passthrough();

export type CalibrateBlob = z.infer<typeof CalibrateBlobSchema>;

// Schema↔type parity is enforced structurally: `evaluate` is typed `Promise<Verdict>`
// and returns `VerdictSchema.parse(...)`, so any drift fails the type-check there.

export interface EvalClientDeps {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout; a hung sidecar must not stall the gated-generation loop. */
  timeoutMs?: number;
  /**
   * Loads the persisted /calibrate blob for (author, register) from storage. Wired
   * by the live factory. When present, `evaluate` recovers from a sidecar that lost
   * its in-memory calibration (e.g. after a restart): on a 404 it re-seeds from this
   * blob and retries once, instead of failing until the next full rebuild.
   */
  loadCalibration?: (author_id: string, register: Register) => Promise<unknown | null>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface EvalClient extends Evaluator {
  calibrate(
    author_id: string,
    register: Register,
    genuine: string[],
    impostors: string[],
    mfwCount?: number,
  ): Promise<CalibrateBlob>;
  /** Restore a persisted calibration blob into the sidecar's in-memory cache. */
  seed(author_id: string, register: Register, blob: unknown): Promise<void>;
  health(): Promise<{ status: string; profiles_loaded: number }>;
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`eval-harness ${url} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Create an eval-harness client over an injected base URL (and optional fetch). */
export function createEvalClient(deps: EvalClientDeps): EvalClient {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function seed(author_id: string, register: Register, blob: unknown): Promise<void> {
    await postJson(doFetch, `${base}/seed`, { author_id, register, blob }, timeoutMs);
  }

  return {
    async evaluate(
      text: string,
      author_id: string,
      register: Register,
      strictness: string,
    ): Promise<Verdict> {
      const callEvaluate = () =>
        doFetch(`${base}/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, author_id, register, strictness }),
          signal: AbortSignal.timeout(timeoutMs),
        });

      let res = await callEvaluate();
      // The sidecar caches calibration in memory and 404s after a restart until it's
      // re-seeded. If a loader is wired, restore the persisted blob and retry ONCE
      // (no rebuild needed). A still-missing blob falls through to the error below.
      if (res.status === 404 && deps.loadCalibration) {
        const blob = await deps.loadCalibration(author_id, register);
        if (blob != null) {
          await seed(author_id, register, blob);
          res = await callEvaluate();
        }
      }
      if (!res.ok) {
        throw new Error(`eval-harness ${base}/evaluate → ${res.status}: ${await res.text()}`);
      }
      return VerdictSchema.parse(await res.json());
    },

    seed,

    async calibrate(
      author_id: string,
      register: Register,
      genuine: string[],
      impostors: string[],
      mfwCount = 200,
    ): Promise<CalibrateBlob> {
      const json = await postJson(
        doFetch,
        `${base}/calibrate`,
        { author_id, register, genuine, impostors, mfw_count: mfwCount },
        timeoutMs,
      );
      return CalibrateBlobSchema.parse(json);
    },

    async health(): Promise<{ status: string; profiles_loaded: number }> {
      const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        throw new Error(`eval-harness /health → ${res.status}`);
      }
      return z.object({ status: z.string(), profiles_loaded: z.number() }).parse(await res.json());
    },
  };
}
