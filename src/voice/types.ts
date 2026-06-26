/**
 * Voice-model types (spec 04 §3, §4).
 *
 * A voice is a register-keyed family, not one flat style (research §1.3). Each
 * register has a profile: a style card (computed targets from eval-harness +
 * LLM-extracted prose) and refs into storage for exemplars + the style centroid.
 */
import type { Register } from "../corpus-record";

export type Readiness = "insufficient" | "generation-ready" | "profile-grade";

/** Computed, factual targets (eval-harness /features) — can't drift from the corpus. */
export interface StyleCardTargets {
  sentence_len_mean: number;
  sentence_len_variance: number;
  mattr: number;
  punctuation_profile: Record<string, number>;
  contraction_rate: number;
  emoji_rate: number;
  lowercase_start_rate: number;
  signature_ngrams: string[];
}

/** LLM-extracted prose descriptors — POSITIVELY framed (spec §6). */
export interface StyleCardProse {
  voice_summary: string;
  habits: string[];
  do_more_of: string[];
}

export interface StyleCard {
  targets: StyleCardTargets;
  prose: StyleCardProse;
}

export interface RegisterProfile {
  version: string;
  style_card: StyleCard;
  exemplar_pool_ref: string; // → voice.exemplars (author+register, canonical)
  centroid_ref: string; // → voice.profiles.style_centroid (gate + style-coverage selection)
  readiness: Readiness;
}

export interface VoiceProfile {
  author_id: string;
  registers: Record<Register, RegisterProfile | null>; // null ⇒ cold-start for that register
}

/** Mirror of the eval-harness /evaluate response (spec 03 §4). */
export interface GateA {
  passed: boolean;
  cosine_delta: number;
  style_cosine: number | null;
  percentile: number;
  threshold_percentile: number;
}

export interface Verdict {
  verdict: "PASS" | "REVIEW" | "FAIL";
  gate_a: GateA;
  gate_b: { flag: "none" | "low" | "high"; abstained: boolean };
  register: Register;
  word_count: number;
}
