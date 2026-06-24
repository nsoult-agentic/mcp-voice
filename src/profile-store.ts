/**
 * Profile store — tier-2 distilled voice profiles (spec 02 §3, §4, §7.3, §8, §9).
 *
 * `voice.profiles` holds the versioned, per-register voice descriptor (prose style
 * card + aggregate stylometric vector + style-embedding centroid), written by
 * `voice-model`/`eval-harness` and read at generation time. This layer owns the
 * persistence + lifecycle invariants:
 *
 *   - Profiles are IMMUTABLE per `version` (§9): a rebuild writes a NEW version;
 *     re-writing the same version is an idempotent no-op.
 *   - Activation is an ATOMIC swap (§7.3, §10.6): exactly one version is active per
 *     `(author_id, register)`. A new build is written inactive, then activated; a
 *     FAILED activation (unknown version) rolls back and never deactivates the live
 *     one. A partial unique index backstops the invariant at the DB level.
 *
 * `style_card` / `stylometric_vector` are opaque jsonb to this layer — their shape
 * is owned by the eval-harness / voice-model specs.
 */
import type { Register } from "./corpus-record";
import type { Sql } from "./db";
import { parseVectorLiteral, STYLE_DIM, toVectorLiteral } from "./vector";

export interface ProfileInput {
  author_id: string;
  register: Register;
  version: string;
  style_card: unknown;
  stylometric_vector: unknown;
  style_centroid: number[] | null;
  built_at: string;
  exemplar_count: number;
}

export interface Profile extends ProfileInput {
  is_active: boolean;
}

export interface ProfileStore {
  /** Insert a new (inactive) immutable version; re-writing the same version is a no-op. */
  writeProfile(input: ProfileInput): Promise<void>;
  /**
   * Atomically make `version` the single active profile for (author_id, register).
   * Not internally serialized: callers should not race concurrent activations of
   * different versions for the same (author_id, register) — the partial unique
   * index is the backstop (one racer errors; the one-active invariant always holds).
   */
  activateProfile(author_id: string, register: Register, version: string): Promise<void>;
  /** The currently active profile for (author_id, register), or null. */
  getActiveProfile(author_id: string, register: Register): Promise<Profile | null>;
  getProfile(author_id: string, register: Register, version: string): Promise<Profile | null>;
  /** All version ids for (author_id, register), most recently built first. */
  listVersions(author_id: string, register: Register): Promise<string[]>;
}

const SELECT_COLUMNS = `
  author_id, register, version, style_card, stylometric_vector,
  style_centroid::text AS style_centroid_text, built_at, exemplar_count, is_active`;

function toProfile(row: Record<string, unknown>): Profile {
  return {
    author_id: row["author_id"] as string,
    register: row["register"] as Register,
    version: row["version"] as string,
    style_card: row["style_card"],
    stylometric_vector: row["stylometric_vector"],
    style_centroid: parseVectorLiteral(row["style_centroid_text"]),
    built_at: (row["built_at"] as Date).toISOString(),
    exemplar_count: row["exemplar_count"] as number,
    is_active: row["is_active"] as boolean,
  };
}

export function createProfileStore(deps: { sql: Sql }): ProfileStore {
  const { sql } = deps;

  return {
    async writeProfile(input: ProfileInput): Promise<void> {
      const centroid =
        input.style_centroid === null
          ? null
          : sql`${toVectorLiteral(input.style_centroid, STYLE_DIM)}::vector`;
      // style_card / stylometric_vector are opaque jsonb to this layer; cast at the
      // driver boundary (their shape is owned by eval-harness / voice-model).
      const asJson = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
      await sql`
        INSERT INTO voice.profiles (
          author_id, register, version, style_card, stylometric_vector,
          style_centroid, built_at, exemplar_count, is_active
        ) VALUES (
          ${input.author_id}, ${input.register}::voice.register, ${input.version},
          ${asJson(input.style_card)}, ${asJson(input.stylometric_vector)},
          ${centroid}, ${input.built_at}, ${input.exemplar_count}, false
        )
        ON CONFLICT (author_id, register, version) DO NOTHING`;
    },

    async activateProfile(author_id: string, register: Register, version: string): Promise<void> {
      // Deactivate the current active, then activate the target. If the target
      // version doesn't exist the second UPDATE matches 0 rows → throw → the whole
      // transaction rolls back, so the live version is never left deactivated (§10.6).
      await sql.begin(async (tx) => {
        await tx`
          UPDATE voice.profiles SET is_active = false
          WHERE author_id = ${author_id} AND register = ${register}::voice.register AND is_active`;
        const activated = await tx`
          UPDATE voice.profiles SET is_active = true
          WHERE author_id = ${author_id} AND register = ${register}::voice.register
            AND version = ${version}
          RETURNING version`;
        if (activated.length === 0) {
          throw new Error(
            `No such profile version to activate: ${author_id}/${register}/${version}`,
          );
        }
      });
    },

    async getActiveProfile(author_id: string, register: Register): Promise<Profile | null> {
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SELECT_COLUMNS} FROM voice.profiles
           WHERE author_id = $1 AND register = $2::voice.register AND is_active
           LIMIT 1`,
        [author_id, register],
      );
      const row = rows[0];
      return row === undefined ? null : toProfile(row);
    },

    async getProfile(
      author_id: string,
      register: Register,
      version: string,
    ): Promise<Profile | null> {
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SELECT_COLUMNS} FROM voice.profiles
           WHERE author_id = $1 AND register = $2::voice.register AND version = $3`,
        [author_id, register, version],
      );
      const row = rows[0];
      return row === undefined ? null : toProfile(row);
    },

    async listVersions(author_id: string, register: Register): Promise<string[]> {
      const rows = await sql<{ version: string }[]>`
        SELECT version FROM voice.profiles
        WHERE author_id = ${author_id} AND register = ${register}::voice.register
        ORDER BY built_at DESC, version DESC`;
      return rows.map((row) => row.version);
    },
  };
}
