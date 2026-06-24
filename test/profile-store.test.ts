import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createProfileStore, type ProfileInput, type ProfileStore } from "../src/profile-store.ts";
import { applyMigrations } from "../src/schema.ts";
import { STYLE_DIM } from "../src/vector.ts";
import { testDb } from "./support/pg.ts";

// Profiles tier-2 (spec 02 §3, §4, §7.3, §9, acceptance §10.6). INTEGRATION:
// real Postgres + pgvector — runs in CI (RUN_DB_TESTS=1), skips locally. Profiles
// are immutable per version; activation atomically swaps the single active version
// per (author_id, register); a failed activation never deactivates the live one.

const RUN_DB = process.env["RUN_DB_TESTS"] === "1";

function profile(over: Partial<ProfileInput> = {}): ProfileInput {
  return {
    author_id: "operator",
    register: "email",
    version: "v1",
    style_card: { tone: "warm", targets: { avg_sentence_len: 14 } },
    stylometric_vector: { mfw: [0.1, 0.2, 0.3] },
    style_centroid: Array.from({ length: STYLE_DIM }, (_, i) => (i % 10) / 10),
    built_at: "2026-06-01T00:00:00.000Z",
    exemplar_count: 42,
    ...over,
  };
}

async function activeCount(
  sql: ReturnType<typeof testDb>,
  author_id: string,
  register: string,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM voice.profiles
    WHERE author_id = ${author_id} AND register = ${register}::voice.register AND is_active`;
  return rows[0]?.n ?? 0;
}

describe.skipIf(!RUN_DB)("profile store (integration, pgvector)", () => {
  let store: ProfileStore;
  let sql: ReturnType<typeof testDb>;

  beforeAll(async () => {
    sql = testDb();
    await applyMigrations(sql);
    store = createProfileStore({ sql });
  });

  beforeEach(async () => {
    await sql`TRUNCATE voice.profiles`;
  });

  afterAll(async () => {
    await sql.end();
  });

  test("round-trip: a profile writes and reads back (jsonb + centroid)", async () => {
    await store.writeProfile(profile());
    const back = await store.getProfile("operator", "email", "v1");
    expect(back).not.toBeNull();
    expect(back?.style_card).toEqual({ tone: "warm", targets: { avg_sentence_len: 14 } });
    expect(back?.stylometric_vector).toEqual({ mfw: [0.1, 0.2, 0.3] });
    expect(back?.style_centroid).toHaveLength(STYLE_DIM); // float4 precision → length, not exact values
    expect(back?.built_at).toBe("2026-06-01T00:00:00.000Z");
    expect(back?.exemplar_count).toBe(42);
  });

  test("a freshly written profile is inactive; no active profile yet (§7.3)", async () => {
    await store.writeProfile(profile());
    const written = await store.getProfile("operator", "email", "v1");
    expect(written?.is_active).toBe(false);
    expect(await store.getActiveProfile("operator", "email")).toBeNull();
  });

  test("activation makes a version the active one (§7.3, §8)", async () => {
    await store.writeProfile(profile());
    await store.activateProfile("operator", "email", "v1");
    const active = await store.getActiveProfile("operator", "email");
    expect(active?.version).toBe("v1");
    expect(active?.is_active).toBe(true);
  });

  test("activating a new version atomically deactivates the previous (exactly one active, §10.6)", async () => {
    await store.writeProfile(profile({ version: "v1" }));
    await store.writeProfile(profile({ version: "v2" }));
    await store.activateProfile("operator", "email", "v1");
    await store.activateProfile("operator", "email", "v2");

    expect((await store.getActiveProfile("operator", "email"))?.version).toBe("v2");
    expect((await store.getProfile("operator", "email", "v1"))?.is_active).toBe(false);
    expect(await activeCount(sql, "operator", "email")).toBe(1);
  });

  test("a failed activation (unknown version) never deactivates the live one (§10.6)", async () => {
    await store.writeProfile(profile({ version: "v1" }));
    await store.activateProfile("operator", "email", "v1");

    await expect(store.activateProfile("operator", "email", "v999")).rejects.toThrow();

    // The live version is untouched — rollback preserved exactly one active.
    expect((await store.getActiveProfile("operator", "email"))?.version).toBe("v1");
    expect(await activeCount(sql, "operator", "email")).toBe(1);
  });

  test("active profiles are tracked per (author_id, register) independently", async () => {
    await store.writeProfile(profile({ register: "email", version: "e1" }));
    await store.writeProfile(profile({ register: "chat", version: "c1" }));
    await store.activateProfile("operator", "email", "e1");
    await store.activateProfile("operator", "chat", "c1");
    expect((await store.getActiveProfile("operator", "email"))?.version).toBe("e1");
    expect((await store.getActiveProfile("operator", "chat"))?.version).toBe("c1");
  });

  test("writeProfile is idempotent on (author_id, register, version) — versions are immutable", async () => {
    await store.writeProfile(profile({ version: "v1" }));
    await store.writeProfile(profile({ version: "v1" }));
    expect(await store.listVersions("operator", "email")).toEqual(["v1"]);
  });

  test("a one-active partial unique index backstops the invariant (§10.6)", async () => {
    // Defense-in-depth: the schema carries a UNIQUE partial index on (author_id,
    // register) WHERE is_active, so the DB itself cannot hold two active versions.
    // Assert it exists + is unique + partial via the catalog (deterministic).
    const idx = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'voice' AND tablename = 'profiles'
        AND indexname = 'profiles_one_active'`;
    expect(idx[0]?.indexdef).toMatch(/UNIQUE/i);
    expect(idx[0]?.indexdef).toMatch(/is_active/);
  });
});
