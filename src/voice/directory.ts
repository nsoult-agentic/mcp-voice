/**
 * voice. directory queries (spec 06 §4) — the storage-backed reads behind
 * voice_list / voice_status, plus the "other authors" impostor fetcher that grows
 * the calibration contrast class as more voices are onboarded (the storage half of
 * the hybrid impostor source).
 *
 * Read-only over the isolated `voice.` schema; registers are cast through the
 * `voice.register` enum so only valid values ever reach the planner.
 */
import type { Register } from "../corpus-record";
import { REGISTERS } from "../corpus-record";
import type { Sql } from "../db";
import type { ProfileDirectory } from "./engine";
import type { VoiceListResult, VoiceStatusResult } from "./mcp/schemas";
import { PROFILE_GRADE_MIN } from "./types";

const DEFAULT_IMPOSTOR_LIMIT = 200;

function readiness(exemplarCount: number): "generation-ready" | "profile-grade" {
  return exemplarCount >= PROFILE_GRADE_MIN ? "profile-grade" : "generation-ready";
}

/** ProfileDirectory backed by the voice. schema. */
export function createProfileDirectory(deps: { sql: Sql }): ProfileDirectory {
  const { sql } = deps;
  return {
    async listVoices(): Promise<VoiceListResult> {
      const rows = await sql<{ author_id: string; registers: string[] }[]>`
        SELECT author_id, array_agg(register::text ORDER BY register) AS registers
        FROM voice.profiles
        WHERE is_active
        GROUP BY author_id
        ORDER BY author_id`;
      return {
        voices: rows.map((r) => ({
          voice_id: r.author_id,
          registers_ready: r.registers as Register[],
        })),
      };
    },

    async voiceStatus(voice_id: string): Promise<VoiceStatusResult> {
      const active = await sql<{ register: string; exemplar_count: number; built_at: Date }[]>`
        SELECT register::text AS register, exemplar_count, built_at
        FROM voice.profiles
        WHERE author_id = ${voice_id} AND is_active`;
      const counts = await sql<{ register: string; n: number }[]>`
        SELECT register::text AS register, count(*)::int AS n
        FROM voice.exemplars
        WHERE author_id = ${voice_id} AND is_canonical
        GROUP BY register`;

      const byRegisterActive = new Map(active.map((a) => [a.register, a]));
      const byRegisterCount = new Map(counts.map((c) => [c.register, c.n]));

      const registers: VoiceStatusResult["registers"] = REGISTERS.map((register) => {
        const profile = byRegisterActive.get(register);
        const exemplars = profile?.exemplar_count ?? byRegisterCount.get(register) ?? 0;
        const coverage = Math.max(0, Math.min(1, exemplars / PROFILE_GRADE_MIN));
        if (profile) {
          return {
            register,
            readiness: readiness(profile.exemplar_count),
            coverage,
            last_eval: profile.built_at.toISOString(),
          };
        }
        // No active profile yet → insufficient, but surface exemplar progress.
        return { register, readiness: "insufficient", coverage, last_eval: null };
      });

      return { voice_id, registers };
    },
  };
}

/**
 * Fetch canonical exemplar text from OTHER authors in the same register — the
 * storage-backed `otherAuthors` for createHybridImpostorSource. Empty when the
 * operator is the only voice (the bundled baseline then carries calibration).
 */
export function createOtherAuthorsSource(deps: {
  sql: Sql;
  limit?: number;
}): (author_id: string, register: Register) => Promise<string[]> {
  const { sql } = deps;
  const limit = deps.limit ?? DEFAULT_IMPOSTOR_LIMIT;
  return async (author_id: string, register: Register): Promise<string[]> => {
    const rows = await sql<{ text: string }[]>`
      SELECT text FROM voice.exemplars
      WHERE author_id <> ${author_id}
        AND register = ${register}::voice.register
        AND is_canonical
      LIMIT ${limit}`;
    return rows.map((r) => r.text);
  };
}
