/**
 * buildRegisterProfile (spec 04 §5) — the build-time path that turns a register's
 * canonical exemplars into an active, versioned profile.
 *
 *   canonical exemplars → /calibrate (targets + centroid + thresholds)
 *                       → one-shot LLM prose
 *                       → write immutable version → activate atomically
 *
 * Calibration needs an impostor (other-human) contrast class. The hybrid source
 * unions a bundled baseline with any OTHER authors in storage (operator's choice):
 * works when the operator is the only voice, sharpens as voices are onboarded.
 *
 * All dependencies are injected → unit-testable without a live API, sidecar, or DB.
 */
import type { Register } from "../corpus-record";
import type { Exemplar, ExemplarStore } from "../exemplar-store";
import type { ProfileStore } from "../profile-store";
import type { CalibrateBlob } from "./eval-client";
import { BUNDLED_NEGATIVES } from "./negatives";
import type { ProseExtractor } from "./prose-extractor";
import { PROFILE_GRADE_MIN, type Readiness, type StyleCard } from "./types";

/** Spec §5: require ≥ ~5 canonical exemplars, else the register is cold-start (§8). */
export const MIN_EXEMPLARS = 5;
const MAX_GENUINE = 500; // upper bound on the genuine corpus pulled for calibration
const PROSE_SAMPLE = 8; // exemplars shown to the prose extractor

/** Raised when a register lacks enough corpus to build a profile (caller → cold-start). */
export class InsufficientCorpusError extends Error {
  constructor(
    readonly author_id: string,
    readonly register: Register,
    readonly count: number,
  ) {
    super(`insufficient corpus for (${author_id}, ${register}): ${count} < ${MIN_EXEMPLARS}`);
    this.name = "InsufficientCorpusError";
  }
}

/** The eval-client surface buildRegisterProfile needs. */
export interface Calibrator {
  calibrate(
    author_id: string,
    register: Register,
    genuine: string[],
    impostors: string[],
    mfwCount?: number,
  ): Promise<CalibrateBlob>;
}

/** Supplies the other-human contrast class for calibration. */
export interface ImpostorSource {
  collect(author_id: string, register: Register): Promise<string[]>;
}

/**
 * Bundled baseline ∪ other stored authors (the operator's hybrid choice). `bundled`
 * defaults to the shipped baseline; `otherAuthors` (the storage-backed fetcher) is
 * wired by the top-level factory and grows the contrast class as voices are added.
 */
export function createHybridImpostorSource(deps: {
  bundled?: string[];
  otherAuthors?: (author_id: string, register: Register) => Promise<string[]>;
}): ImpostorSource {
  const bundled = deps.bundled ?? BUNDLED_NEGATIVES;
  return {
    async collect(author_id: string, register: Register): Promise<string[]> {
      const extra = deps.otherAuthors ? await deps.otherAuthors(author_id, register) : [];
      return [...bundled, ...extra];
    },
  };
}

/** Element-wise mean of equal-length vectors; null if there are none. */
export function meanVector(vectors: number[][]): number[] | null {
  if (vectors.length === 0) {
    return null;
  }
  const dim = vectors[0]?.length ?? 0;
  // Fail loud on ragged input rather than silently dragging the centroid toward
  // zero (the live path is all-768d, but a future off-path caller shouldn't average
  // mismatched dims into a wrong vector).
  if (vectors.some((v) => v.length !== dim)) {
    throw new Error(`meanVector: vectors must share a dimension (expected ${dim})`);
  }
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) {
      sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  return sum.map((x) => x / vectors.length);
}

export interface BuildProfileDeps {
  exemplars: ExemplarStore;
  calibrator: Calibrator;
  prose: ProseExtractor;
  impostors: ImpostorSource;
  profiles: ProfileStore;
}

export interface BuildProfileOptions {
  author_id: string;
  register: Register;
  version: string; // immutable version id (caller-generated)
  builtAt: string; // ISO timestamp (caller-stamped — keeps this pure/testable)
}

export interface BuildProfileResult {
  version: string;
  exemplar_count: number;
  readiness: Readiness;
  roc_auc: number;
}

export async function buildRegisterProfile(
  deps: BuildProfileDeps,
  opts: BuildProfileOptions,
): Promise<BuildProfileResult> {
  const { author_id, register, version, builtAt } = opts;

  const genuineRows = await deps.exemplars.retrieve({ author_id, register, k: MAX_GENUINE });
  if (genuineRows.length < MIN_EXEMPLARS) {
    throw new InsufficientCorpusError(author_id, register, genuineRows.length);
  }
  const genuine = genuineRows.map((e) => e.text);

  const impostors = await deps.impostors.collect(author_id, register);
  const blob = await deps.calibrator.calibrate(author_id, register, genuine, impostors);
  const prose = await deps.prose.extract(genuine.slice(0, PROSE_SAMPLE));

  const style_card: StyleCard = { targets: blob.targets, prose };
  const style_centroid = meanVector(
    genuineRows.map((e: Exemplar) => e.style_embedding).filter((v): v is number[] => v !== null),
  );

  await deps.profiles.writeProfile({
    author_id,
    register,
    version,
    style_card,
    stylometric_vector: blob, // the calibrate blob — re-seeds the sidecar on restart
    style_centroid,
    built_at: builtAt,
    exemplar_count: genuine.length,
  });
  await deps.profiles.activateProfile(author_id, register, version);

  return {
    version,
    exemplar_count: genuine.length,
    readiness: genuine.length >= PROFILE_GRADE_MIN ? "profile-grade" : "generation-ready",
    roc_auc: blob.metrics.roc_auc,
  };
}
