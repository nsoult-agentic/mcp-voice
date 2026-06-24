import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { CorpusRecord } from "../src/corpus-record.ts";
import type { Embedder } from "../src/embedder.ts";
import { createExemplarStore, type ExemplarStore } from "../src/exemplar-store.ts";
import { applyMigrations } from "../src/schema.ts";
import { CONTENT_DIM, STYLE_DIM } from "../src/vector.ts";
import { testDb } from "./support/pg.ts";

// Exemplar store write path + round-trip (spec 02 §7, §10.1-2). INTEGRATION:
// needs a real Postgres + pgvector. Runs in CI (RUN_DB_TESTS=1, pgvector service)
// and skips locally where no DB is configured. The DB is the source of truth for
// these acceptance criteria — they cannot be faithfully faked.

const RUN_DB = process.env["RUN_DB_TESTS"] === "1";

/** Deterministic stub embedder (S2). Content isn't meaningful pre-retrieval — only
 *  presence, finiteness, and dimension matter for this slice. */
function stubEmbedder(dim: number): Embedder {
  return {
    dimensions: dim,
    async embed(text: string): Promise<number[]> {
      let seed = 1;
      for (const ch of text) {
        seed = (seed + ch.charCodeAt(0)) % 997;
      }
      return Array.from({ length: dim }, (_, i) => ((seed + i) % 100) / 100);
    },
  };
}

const embedders = { content: stubEmbedder(CONTENT_DIM), style: stubEmbedder(STYLE_DIM) };

function record(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    id: "rec-1",
    author_id: "operator",
    medium: "email",
    register: "email",
    source_uri: "message-id:<m1@host>",
    thread_id: "t1",
    timestamp: "2026-06-01T09:00:00.000Z",
    text_clean: "Yeah, I'll have them over to you tonight — promise! 🙂",
    word_count: 9,
    dedup_cluster_id: "rec-1",
    is_canonical: true,
    ingest_version: "ingestion-slice-3",
    ...over,
  };
}

describe.skipIf(!RUN_DB)("exemplar store (integration, pgvector)", () => {
  let store: ExemplarStore;
  let sql: ReturnType<typeof testDb>;

  beforeAll(async () => {
    sql = testDb();
    await applyMigrations(sql);
    store = createExemplarStore({ sql, embedders });
  });

  beforeEach(async () => {
    await sql`TRUNCATE voice.exemplars`;
  });

  afterAll(async () => {
    await sql.end();
  });

  test("round-trip: a record writes and reads back identically (§10.1)", async () => {
    const r = record();
    const inserted = await store.upsert([r]);
    expect(inserted).toBe(1);

    const back = await store.getById(r.id);
    expect(back).not.toBeNull();
    expect(back?.id).toBe(r.id);
    expect(back?.author_id).toBe("operator");
    expect(back?.register).toBe("email");
    expect(back?.medium).toBe("email");
    expect(back?.source_uri).toBe(r.source_uri);
    expect(back?.thread_id).toBe("t1");
    expect(back?.text).toBe(r.text_clean); // voice preserved byte-for-byte
    expect(back?.word_count).toBe(9);
    expect(back?.dedup_cluster_id).toBe("rec-1");
    expect(back?.is_canonical).toBe(true);
    expect(back?.authored_at).toBe("2026-06-01T09:00:00.000Z");
    expect(back?.ingest_version).toBe("ingestion-slice-3");
  });

  test("re-writing the same batch is a no-op (idempotent on id, §10.1)", async () => {
    const r = record();
    expect(await store.upsert([r])).toBe(1);
    expect(await store.upsert([r])).toBe(0); // already present → skipped
    const all = await store.getByIds([r.id]);
    expect(all).toHaveLength(1);
  });

  test("every canonical exemplar has both embeddings populated (§10.2)", async () => {
    await store.upsert([record()]);
    const back = await store.getById("rec-1");
    expect(back?.content_embedding).toHaveLength(CONTENT_DIM);
    expect(back?.style_embedding).toHaveLength(STYLE_DIM);
  });

  test("a non-canonical (dedup-loser) row is stored for provenance with NULL embeddings", async () => {
    await store.upsert([record({ id: "loser", is_canonical: false, dedup_cluster_id: "rec-1" })]);
    const back = await store.getById("loser");
    expect(back?.is_canonical).toBe(false);
    expect(back?.content_embedding).toBeNull();
    expect(back?.style_embedding).toBeNull();
  });

  test("registers are stored faithfully across a mixed batch", async () => {
    await store.upsert([
      record({ id: "c", register: "chat" }),
      record({ id: "e", register: "email" }),
      record({ id: "l", register: "longform" }),
    ]);
    const rows = await store.getByIds(["c", "e", "l"]);
    const byId = new Map(rows.map((row) => [row.id, row.register]));
    expect(byId.get("c")).toBe("chat");
    expect(byId.get("e")).toBe("email");
    expect(byId.get("l")).toBe("longform");
  });

  test("exemplars live in the isolated voice schema, not public (§9 isolation)", async () => {
    // Assert the schema via the catalog (regclass::text drops the prefix when the
    // schema is on search_path, which it is here since the DB user is `voice`).
    const schema = await sql<{ nspname: string }[]>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('voice.exemplars')`;
    expect(schema[0]?.nspname).toBe("voice");

    // And there is no exemplars table in public (knowledge-table territory).
    const inPublic = await sql<{ reg: string | null }[]>`
      SELECT to_regclass('public.exemplars')::text AS reg`;
    expect(inPublic[0]?.reg).toBeNull();
  });
});
