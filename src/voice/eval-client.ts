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
}

export interface EvalClient extends Evaluator {
  calibrate(
    author_id: string,
    register: Register,
    genuine: string[],
    impostors: string[],
    mfwCount?: number,
  ): Promise<CalibrateBlob>;
  health(): Promise<{ status: string; profiles_loaded: number }>;
}

async function postJson(doFetch: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

  return {
    async evaluate(
      text: string,
      author_id: string,
      register: Register,
      strictness: string,
    ): Promise<Verdict> {
      const json = await postJson(doFetch, `${base}/evaluate`, {
        text,
        author_id,
        register,
        strictness,
      });
      return VerdictSchema.parse(json);
    },

    async calibrate(
      author_id: string,
      register: Register,
      genuine: string[],
      impostors: string[],
      mfwCount = 200,
    ): Promise<CalibrateBlob> {
      const json = await postJson(doFetch, `${base}/calibrate`, {
        author_id,
        register,
        genuine,
        impostors,
        mfw_count: mfwCount,
      });
      return CalibrateBlobSchema.parse(json);
    },

    async health(): Promise<{ status: string; profiles_loaded: number }> {
      const res = await doFetch(`${base}/health`);
      if (!res.ok) {
        throw new Error(`eval-harness /health → ${res.status}`);
      }
      return z.object({ status: z.string(), profiles_loaded: z.number() }).parse(await res.json());
    },
  };
}
