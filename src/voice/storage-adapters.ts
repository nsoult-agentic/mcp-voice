/**
 * Storage adapters (spec 04 wiring) — bridge the `ExemplarSource` / `ProfileSource`
 * seams of the gated loop to the persisted exemplar/profile stores.
 *
 * - styleExemplars → register-scoped, style-primary retrieval (no seed ⇒ recency
 *   fallback, §8), returning just the exemplar text for few-shot.
 * - groundingExemplars → content-axis retrieval seeded by a query, facts only.
 * - getActiveProfile → maps the persisted Profile to the loop's RegisterProfile,
 *   VALIDATING the jsonb style_card at the seam (it's stored as `unknown`).
 */
import { z } from "zod";
import type { Register } from "../corpus-record";
import type { ExemplarStore } from "../exemplar-store";
import type { ProfileStore } from "../profile-store";
import type { ExemplarSource, ProfileSource } from "./generate";
import { PROFILE_GRADE_MIN, type Readiness, type RegisterProfile, type StyleCard } from "./types";

const StyleCardSchema = z.object({
  targets: z.object({
    sentence_len_mean: z.number(),
    sentence_len_variance: z.number(),
    mattr: z.number(),
    punctuation_profile: z.record(z.string(), z.number()),
    contraction_rate: z.number(),
    emoji_rate: z.number(),
    lowercase_start_rate: z.number(),
    signature_ngrams: z.array(z.string()),
  }),
  prose: z.object({
    voice_summary: z.string(),
    habits: z.array(z.string()),
    do_more_of: z.array(z.string()),
  }),
});

// Compile-time guarantee the schema and the hand-written StyleCard match BOTH ways:
// infer→type catches a schema field the type lacks; type→infer catches a type field
// the schema lacks (which parse() would silently strip → loop reads undefined).
const _parityA: StyleCard = {} as z.infer<typeof StyleCardSchema>;
const _parityB: z.infer<typeof StyleCardSchema> = {} as StyleCard;
void _parityA;
void _parityB;

/** An active profile is at least generation-ready; richer corpora earn profile-grade. */
function readinessFor(exemplarCount: number): Readiness {
  return exemplarCount >= PROFILE_GRADE_MIN ? "profile-grade" : "generation-ready";
}

/** ExemplarSource backed by the persisted exemplar store. */
export function createStorageExemplarSource(store: ExemplarStore): ExemplarSource {
  return {
    async styleExemplars(author_id: string, register: Register, k: number): Promise<string[]> {
      const rows = await store.retrieve({ author_id, register, k });
      return rows.map((e) => e.text);
    },
    async groundingExemplars(
      author_id: string,
      register: Register,
      query: string,
      k: number,
    ): Promise<string[]> {
      const rows = await store.retrieve({ author_id, register, queryText: query, k });
      return rows.map((e) => e.text);
    },
  };
}

/** ProfileSource backed by the persisted profile store. */
export function createStorageProfileSource(store: ProfileStore): ProfileSource {
  return {
    async getActiveProfile(author_id: string, register: Register): Promise<RegisterProfile | null> {
      const profile = await store.getActiveProfile(author_id, register);
      if (profile === null) {
        return null;
      }
      const style_card = StyleCardSchema.parse(profile.style_card);
      return {
        version: profile.version,
        style_card,
        exemplar_pool_ref: `${author_id}:${register}`,
        centroid_ref: `${author_id}:${register}:${profile.version}`,
        readiness: readinessFor(profile.exemplar_count),
      };
    },
  };
}
