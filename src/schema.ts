/**
 * `voice.` schema migration (spec 02 §4).
 *
 * Idempotent DDL: safe to run on every startup and in test setup. Creates the
 * pgvector extension, the isolated `voice.` schema, the register enum, the tier-1
 * `voice.exemplars` table with BOTH embedding columns, the per-register partial
 * HNSW retrieval indexes (§6), and the tier-2 `voice.profiles` table with its
 * one-active-version partial unique index (§10.6). Embedding dimensions come from
 * `vector.ts` so the schema and the validation can never drift apart.
 */
import { REGISTERS } from "./corpus-record";
import type { Sql } from "./db";
import { CONTENT_DIM, STYLE_DIM } from "./vector";

/**
 * Per-register partial HNSW indexes on each embedding column (§6). `register` is a
 * HARD pre-filter on every read; a naive `WHERE register=? ORDER BY emb <=> ?`
 * triggers pgvector's post-filter recall collapse, so we index each register
 * separately and only the `is_canonical` rows that are actually served.
 */
function indexStatements(): string[] {
  const statements: string[] = [];
  for (const register of REGISTERS) {
    for (const axis of ["style_embedding", "content_embedding"] as const) {
      const name = `exemplars_${axis}_${register}`;
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${name}
           ON voice.exemplars USING hnsw (${axis} vector_cosine_ops)
           WHERE register = '${register}' AND is_canonical`,
      );
    }
  }
  return statements;
}

const STATEMENTS: string[] = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "CREATE SCHEMA IF NOT EXISTS voice",
  // CREATE TYPE has no IF NOT EXISTS; swallow duplicate on re-run.
  `DO $$ BEGIN
     CREATE TYPE voice.register AS ENUM ('chat', 'email', 'longform');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS voice.exemplars (
     id                text PRIMARY KEY,
     author_id         text NOT NULL,
     register          voice.register NOT NULL,
     medium            text NOT NULL,
     source_uri        text NOT NULL,
     thread_id         text,
     authored_at       timestamptz NOT NULL,
     ingested_at       timestamptz NOT NULL DEFAULT now(),
     text              text NOT NULL,
     word_count        int NOT NULL,
     dedup_cluster_id  text NOT NULL,
     is_canonical      boolean NOT NULL DEFAULT true,
     content_embedding vector(${CONTENT_DIM}),
     style_embedding   vector(${STYLE_DIM}),
     ingest_version    text NOT NULL,
     profile_version   text
   )`,
  // Tier-2: distilled per-register voice profiles (§4). Immutable per version.
  `CREATE TABLE IF NOT EXISTS voice.profiles (
     author_id          text NOT NULL,
     register           voice.register NOT NULL,
     version            text NOT NULL,
     style_card         jsonb NOT NULL,
     stylometric_vector jsonb NOT NULL,
     style_centroid     vector(${STYLE_DIM}),
     built_at           timestamptz NOT NULL,
     exemplar_count     int NOT NULL,
     is_active          boolean NOT NULL DEFAULT false,
     PRIMARY KEY (author_id, register, version)
   )`,
  // Enforce AT MOST ONE active profile per (author_id, register) at the DB level
  // (§10.6) — defense-in-depth behind the atomic activation swap.
  `CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active
     ON voice.profiles (author_id, register) WHERE is_active`,
  ...indexStatements(),
];

/** Apply the `voice.` schema migration. Idempotent; runs each statement in order. */
export async function applyMigrations(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.unsafe(statement);
  }
}
