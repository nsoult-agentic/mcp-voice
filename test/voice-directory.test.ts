import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { applyMigrations } from "../src/schema.ts";
import { createOtherAuthorsSource, createProfileDirectory } from "../src/voice/directory.ts";
import { testDb } from "./support/pg.ts";

// voice. directory queries (spec 06 §4). INTEGRATION: real Postgres + pgvector —
// runs in CI (RUN_DB_TESTS=1), skips locally.
const RUN_DB = process.env["RUN_DB_TESTS"] === "1";

type Db = ReturnType<typeof testDb>;

async function insertProfile(
  sql: Db,
  p: {
    author_id: string;
    register: string;
    version: string;
    exemplar_count: number;
    is_active: boolean;
    built_at: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO voice.profiles
      (author_id, register, version, style_card, stylometric_vector, built_at, exemplar_count, is_active)
    VALUES (${p.author_id}, ${p.register}::voice.register, ${p.version},
            ${sql.json({ tone: "x" })}, ${sql.json({ mfw: [1] })},
            ${p.built_at}, ${p.exemplar_count}, ${p.is_active})`;
}

async function insertExemplar(
  sql: Db,
  e: { id: string; author_id: string; register: string; text: string },
): Promise<void> {
  await sql`
    INSERT INTO voice.exemplars
      (id, author_id, register, medium, source_uri, authored_at, text, word_count, dedup_cluster_id, is_canonical, ingest_version)
    VALUES (${e.id}, ${e.author_id}, ${e.register}::voice.register, 'matrix', ${e.id}, now(),
            ${e.text}, ${e.text.split(" ").length}, ${e.id}, true, 't')`;
}

describe.skipIf(!RUN_DB)("voice directory (integration, pgvector)", () => {
  let sql: Db;

  beforeAll(async () => {
    sql = testDb();
    await applyMigrations(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE voice.profiles`;
    await sql`TRUNCATE voice.exemplars`;
  });

  afterAll(async () => {
    await sql.end();
  });

  test("listVoices returns voices with their active registers (sorted)", async () => {
    await insertProfile(sql, {
      author_id: "operator",
      register: "email",
      version: "v1",
      exemplar_count: 60,
      is_active: true,
      built_at: "2026-06-01T00:00:00Z",
    });
    await insertProfile(sql, {
      author_id: "operator",
      register: "chat",
      version: "v1",
      exemplar_count: 10,
      is_active: true,
      built_at: "2026-06-01T00:00:00Z",
    });
    await insertProfile(sql, {
      author_id: "alice",
      register: "email",
      version: "v1",
      exemplar_count: 30,
      is_active: true,
      built_at: "2026-06-01T00:00:00Z",
    });
    // an inactive profile must NOT surface
    await insertProfile(sql, {
      author_id: "operator",
      register: "longform",
      version: "v0",
      exemplar_count: 5,
      is_active: false,
      built_at: "2026-06-01T00:00:00Z",
    });

    const { voices } = await createProfileDirectory({ sql }).listVoices();
    expect(voices).toEqual([
      { voice_id: "alice", registers_ready: ["email"] },
      { voice_id: "operator", registers_ready: ["chat", "email"] },
    ]);
  });

  test("voiceStatus derives readiness/coverage/last_eval per register", async () => {
    await insertProfile(sql, {
      author_id: "operator",
      register: "email",
      version: "v1",
      exemplar_count: 60,
      is_active: true,
      built_at: "2026-06-01T00:00:00Z",
    });
    await insertProfile(sql, {
      author_id: "operator",
      register: "chat",
      version: "v1",
      exemplar_count: 10,
      is_active: true,
      built_at: "2026-06-02T00:00:00Z",
    });
    // longform: exemplars but no active profile → insufficient, but coverage reflects them
    for (let i = 0; i < 5; i += 1) {
      await insertExemplar(sql, {
        id: `lf-${i}`,
        author_id: "operator",
        register: "longform",
        text: "a longform sample",
      });
    }

    const status = await createProfileDirectory({ sql }).voiceStatus("operator");
    const byReg = new Map(status.registers.map((r) => [r.register, r]));
    expect(byReg.get("email")).toEqual({
      register: "email",
      readiness: "profile-grade",
      coverage: 1,
      last_eval: "2026-06-01T00:00:00.000Z",
    });
    expect(byReg.get("chat")?.readiness).toBe("generation-ready");
    expect(byReg.get("chat")?.coverage).toBeCloseTo(0.2, 5);
    expect(byReg.get("longform")).toEqual({
      register: "longform",
      readiness: "insufficient",
      coverage: 0.1,
      last_eval: null,
    });
  });

  test("otherAuthors returns same-register canonical text from OTHER authors only", async () => {
    await insertExemplar(sql, {
      id: "op-1",
      author_id: "operator",
      register: "email",
      text: "operator email one",
    });
    await insertExemplar(sql, {
      id: "al-1",
      author_id: "alice",
      register: "email",
      text: "alice email one",
    });
    await insertExemplar(sql, {
      id: "al-2",
      author_id: "alice",
      register: "email",
      text: "alice email two",
    });
    // operator-only chat exemplar — must NOT count as an impostor for the operator
    await insertExemplar(sql, {
      id: "op-chat",
      author_id: "operator",
      register: "chat",
      text: "operator chat msg",
    });

    const others = createOtherAuthorsSource({ sql });
    const emailImpostors = await others("operator", "email");
    expect(emailImpostors.sort()).toEqual(["alice email one", "alice email two"]); // excludes op-1
    // no OTHER author has chat exemplars → empty (operator's own chat excluded)
    expect(await others("operator", "chat")).toEqual([]);
  });
});
