/**
 * `voice.` schema migration (spec 02 §4).
 *
 * Idempotent DDL: safe to run on every startup and in test setup. Creates the
 * pgvector extension, the isolated `voice.` schema, the register enum, and the
 * tier-1 `voice.exemplars` table with BOTH embedding columns. Retrieval indexes
 * (per-register partial HNSW, §6) and the tier-2 `voice.profiles` table arrive in
 * later slices. Embedding dimensions come from `vector.ts` so the schema and the
 * validation can never drift apart.
 */
import type { Sql } from "./db";
import { CONTENT_DIM, STYLE_DIM } from "./vector";

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
];

/** Apply the `voice.` schema migration. Idempotent; runs each statement in order. */
export async function applyMigrations(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.unsafe(statement);
  }
}
