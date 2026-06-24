import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { CorpusRecord, Register } from "../src/corpus-record.ts";
import type { Embedder } from "../src/embedder.ts";
import { createExemplarStore, type ExemplarStore } from "../src/exemplar-store.ts";
import { applyMigrations } from "../src/schema.ts";
import { CONTENT_DIM, STYLE_DIM } from "../src/vector.ts";
import { testDb } from "./support/pg.ts";

// Retrieval primitive (spec 02 §8, acceptance §10.3/§10.4/§10.5). INTEGRATION:
// real Postgres + pgvector — runs in CI (RUN_DB_TESTS=1), skips locally. Uses a
// PROGRAMMABLE embedder (text → vector lookup) so style and content vectors are
// controlled independently per record, letting us prove register isolation,
// style-primary ranking, style≠content separation, and ANN recall deterministically.

const RUN_DB = process.env["RUN_DB_TESTS"] === "1";

/** Deterministic pseudo-random unit-ish vector in [-1,1]^dim from a seed. */
function seededVec(dim: number, seed: number): number[] {
  let s = Math.imul(seed, 2_654_435_761) >>> 0 || 1;
  return Array.from({ length: dim }, () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  });
}

/** A vector dominated by axis `i` (non-zero elsewhere so cosine is well-defined). */
function axisVec(dim: number, i: number): number[] {
  const v = new Array<number>(dim).fill(0.01);
  v[i] = 1;
  return v;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embedder backed by a text→vector map, with a deterministic fallback. */
function mapEmbedder(dim: number, table: Map<string, number[]>): Embedder {
  return {
    dimensions: dim,
    async embed(text: string): Promise<number[]> {
      const hit = table.get(text);
      if (hit !== undefined) {
        return hit;
      }
      let h = 0;
      for (const ch of text) {
        h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
      }
      return seededVec(dim, h);
    },
  };
}

const styleTable = new Map<string, number[]>();
const contentTable = new Map<string, number[]>();
const embedders = {
  content: mapEmbedder(CONTENT_DIM, contentTable),
  style: mapEmbedder(STYLE_DIM, styleTable),
};

function record(over: Partial<CorpusRecord> & { id: string; text_clean: string }): CorpusRecord {
  return {
    author_id: "operator",
    medium: "matrix",
    register: "chat",
    source_uri: `matrix-event:${over.id}`,
    thread_id: null,
    timestamp: "2026-06-01T09:00:00.000Z",
    word_count: 5,
    dedup_cluster_id: over.id,
    is_canonical: true,
    ingest_version: "storage-slice-2",
    ...over,
  };
}

describe.skipIf(!RUN_DB)("retrieve (integration, pgvector)", () => {
  let store: ExemplarStore;
  let sql: ReturnType<typeof testDb>;

  beforeAll(async () => {
    sql = testDb();
    await applyMigrations(sql);
    store = createExemplarStore({ sql, embedders });
  });

  beforeEach(async () => {
    await sql`TRUNCATE voice.exemplars`;
    styleTable.clear();
    contentTable.clear();
  });

  afterAll(async () => {
    await sql.end();
  });

  test("register is a HARD pre-filter — never returns another register's row (§10.3)", async () => {
    // Same style vector across registers: without the filter they'd all rank equally.
    const shared = axisVec(STYLE_DIM, 3);
    styleTable.set("seed", shared);
    for (const reg of ["chat", "email", "longform"] as Register[]) {
      for (let i = 0; i < 3; i += 1) {
        const id = `${reg}-${i}`;
        styleTable.set(id, shared);
        await store.upsert([record({ id, text_clean: id, register: reg })]);
      }
    }
    const got = await store.retrieve({
      author_id: "operator",
      register: "email",
      styleSeed: "seed",
      k: 10,
    });
    expect(got.length).toBe(3);
    expect(got.every((e) => e.register === "email")).toBe(true);
  });

  test("style-only retrieval returns the stylistically nearest exemplar first", async () => {
    styleTable.set("a", axisVec(STYLE_DIM, 0));
    styleTable.set("b", axisVec(STYLE_DIM, 1));
    styleTable.set("c", axisVec(STYLE_DIM, 2));
    styleTable.set("seed", axisVec(STYLE_DIM, 1)); // closest to b
    for (const id of ["a", "b", "c"]) {
      await store.upsert([record({ id, text_clean: id })]);
    }
    const got = await store.retrieve({
      author_id: "operator",
      register: "chat",
      styleSeed: "seed",
      k: 3,
    });
    expect(got[0]?.id).toBe("b");
  });

  test("style ranking outranks content ranking for a topically-similar but stylistically-different probe (§10.5)", async () => {
    // Probe is content-near A but style-near B; style is weighted primary → B wins.
    styleTable.set("probe", axisVec(STYLE_DIM, 0));
    contentTable.set("probe", axisVec(CONTENT_DIM, 0));
    // A: content matches the probe, style does not.
    contentTable.set("A", axisVec(CONTENT_DIM, 0));
    styleTable.set("A", axisVec(STYLE_DIM, 5));
    // B: style matches the probe, content does not.
    styleTable.set("B", axisVec(STYLE_DIM, 0));
    contentTable.set("B", axisVec(CONTENT_DIM, 7));
    await store.upsert([
      record({ id: "A", text_clean: "A" }),
      record({ id: "B", text_clean: "B" }),
    ]);

    const got = await store.retrieve({
      author_id: "operator",
      register: "chat",
      styleSeed: "probe",
      queryText: "probe",
      k: 2,
    });
    expect(got[0]?.id).toBe("B");
  });

  test("ANN recall stays >= 0.8 vs brute-force over a seeded set (§10.4)", async () => {
    const n = 150;
    const k = 10;
    const records: CorpusRecord[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `rec-${i}`;
      styleTable.set(id, seededVec(STYLE_DIM, i + 1));
      records.push(record({ id, text_clean: id }));
    }
    await store.upsert(records);

    const querySeed = seededVec(STYLE_DIM, 99_991);
    styleTable.set("query", querySeed);

    const got = await store.retrieve({
      author_id: "operator",
      register: "chat",
      styleSeed: "query",
      k,
    });

    // Brute-force exact top-k by cosine distance over the known vectors.
    const brute = [...styleTable.entries()]
      .filter(([key]) => key.startsWith("rec-"))
      .map(([id, vec]) => ({ id, d: cosineDistance(querySeed, vec) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .map((e) => e.id);

    const overlap = got.filter((e) => brute.includes(e.id)).length;
    expect(got.length).toBe(k);
    expect(overlap / k).toBeGreaterThanOrEqual(0.8);
  });

  test("no seed falls back to most-recent canonical rows in the register", async () => {
    await store.upsert([
      record({ id: "old", text_clean: "old", timestamp: "2026-01-01T00:00:00.000Z" }),
      record({ id: "new", text_clean: "new", timestamp: "2026-06-01T00:00:00.000Z" }),
    ]);
    const got = await store.retrieve({ author_id: "operator", register: "chat", k: 1 });
    expect(got[0]?.id).toBe("new");
  });
});
