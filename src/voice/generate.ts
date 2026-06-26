/**
 * The gated generation loop (spec 04 §7) — generate → evaluate → retry on Gate A.
 *
 * Dependencies are INJECTED (the live Claude client, the eval-harness HTTP client,
 * and storage retrieval are wired in a later slice), so the orchestration is
 * unit-testable without an API, a DB, or the sidecar.
 *
 * Locked rules:
 * - Retry is gated on Gate A (stylometry) ONLY — never on the Gate-B detector
 *   (Goodhart, §7). A Gate-A-passing, Gate-B-flagged candidate is RETURNED (as
 *   REVIEW), not retried.
 * - The loop never silently fails: a persistent miss returns the best-by-Gate-A
 *   candidate with its REVIEW/FAIL verdict surfaced (operator is the authority).
 * - Cold-start (no profile): few-shot only, forced REVIEW; never fake a register.
 */
import type { Register } from "../corpus-record";
import { assemble } from "./assemble";
import type { RegisterProfile, Strictness, Verdict } from "./types";

export const MAX_ATTEMPTS = 3; // V2: 2 retries / 3 total
const EXEMPLAR_K = 3; // spike: 3 ≈ 5 ≈ 8 — no benefit beyond a few
const GROUNDING_K = 3;

export interface Generator {
  generate(prompt: string): Promise<string>;
}

export interface Evaluator {
  evaluate(
    text: string,
    author_id: string,
    register: Register,
    strictness: Strictness,
  ): Promise<Verdict>;
}

export interface ExemplarSource {
  /** Style-coverage exemplars for (author, register) — ranked on the STYLE axis. */
  styleExemplars(author_id: string, register: Register, k: number): Promise<string[]>;
  /** Optional topical grounding (content-ranked) — facts only. */
  groundingExemplars(
    author_id: string,
    register: Register,
    query: string,
    k: number,
  ): Promise<string[]>;
}

export interface ProfileSource {
  getActiveProfile(author_id: string, register: Register): Promise<RegisterProfile | null>;
}

export interface GenerateDeps {
  generator: Generator;
  evaluator: Evaluator;
  exemplars: ExemplarSource;
  profiles: ProfileSource;
}

export interface GenerateOptions {
  author_id: string;
  register: Register;
  task: string;
  strictness?: Strictness;
  groundingQuery?: string;
}

export interface GenerateResult {
  candidate: string;
  verdict: Verdict;
  attempts: number;
  cold_start: boolean;
}

/** Positive retry guidance from the Gate-A score only — never references the detector (§7). */
function positiveNudge(previous: Verdict): string {
  const pct = Math.round(previous.gate_a.percentile * 100);
  return (
    `That draft already read about ${pct}% like the author — lean further into ` +
    "their own phrasing, sentence rhythm, and characteristic turns so it lands unmistakably as them."
  );
}

export async function generateInVoice(
  deps: GenerateDeps,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const strictness = opts.strictness ?? "normal";
  const profile = await deps.profiles.getActiveProfile(opts.author_id, opts.register);
  const exemplars = await deps.exemplars.styleExemplars(opts.author_id, opts.register, EXEMPLAR_K);

  // Cold-start (§8): no profile → few-shot only, forced REVIEW; never fake a register.
  if (profile === null) {
    const prompt = assemble({ styleCard: null, exemplars, task: opts.task });
    const candidate = await deps.generator.generate(prompt);
    const verdict = await deps.evaluator.evaluate(
      candidate,
      opts.author_id,
      opts.register,
      strictness,
    );
    return { candidate, verdict: { ...verdict, verdict: "REVIEW" }, attempts: 1, cold_start: true };
  }

  const facts = opts.groundingQuery
    ? await deps.exemplars.groundingExemplars(
        opts.author_id,
        opts.register,
        opts.groundingQuery,
        GROUNDING_K,
      )
    : [];

  // `attempts` reports the TOTAL number of generations made. `best` is the highest
  // Gate-A candidate seen so far, returned if no attempt passes.
  let best: { candidate: string; verdict: Verdict } | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const nudge = best ? positiveNudge(best.verdict) : undefined;
    const prompt = assemble({
      styleCard: profile.style_card,
      exemplars,
      facts,
      task: opts.task,
      nudge,
    });
    const candidate = await deps.generator.generate(prompt);
    const verdict = await deps.evaluator.evaluate(
      candidate,
      opts.author_id,
      opts.register,
      strictness,
    );

    // Gate A ONLY decides retry (§7). Gate B can ride along as REVIEW but never retries.
    if (verdict.gate_a.passed) {
      return { candidate, verdict, attempts: attempt, cold_start: false };
    }
    if (best === undefined || verdict.gate_a.percentile > best.verdict.gate_a.percentile) {
      best = { candidate, verdict };
    }
  }

  if (best === undefined) {
    throw new Error("generateInVoice: no attempts ran"); // unreachable: MAX_ATTEMPTS >= 1
  }
  return { ...best, attempts: MAX_ATTEMPTS, cold_start: false }; // best-by-Gate-A, verdict surfaced
}
