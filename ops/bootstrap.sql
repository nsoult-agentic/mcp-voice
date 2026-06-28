-- ============================================================================
-- mcp-voice — one-time database bootstrap
-- ============================================================================
-- Run ONCE, before the first deploy, by piping this file into the second-brain
-- Postgres container as the pai superuser (local socket auth — no password):
--
--   docker exec -i second-brain-db psql -U pai -d second_brain < ops/bootstrap.sql
--
-- It does the two things the least-privilege voice_rw role cannot do itself:
--   1. CREATE EXTENSION vector  — installing a non-trusted extension needs superuser.
--   2. CREATE ROLE voice_rw + CREATE SCHEMA voice AUTHORIZATION voice_rw — a dedicated
--      role that owns ONLY the isolated voice. schema (never the knowledge tables).
--
-- This file sets NO password (so no secret is committed). voice_rw is created with
-- LOGIN but no password yet — set it in the second step (see DEPLOY.md), then the app
-- connects as voice_rw and `bun run migrate` creates the tables/indexes (its
-- CREATE EXTENSION/SCHEMA IF NOT EXISTS calls then no-op).
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. pgvector extension (shared across schemas; superuser-only to install).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Dedicated least-privilege login role (password set separately). Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'voice_rw') THEN
    CREATE ROLE voice_rw LOGIN;
  END IF;
END
$$;

-- 3. Isolated schema, owned by voice_rw (so it can create its own tables/indexes).
CREATE SCHEMA IF NOT EXISTS voice AUTHORIZATION voice_rw;

-- 4. The vector type lives in the extension's schema (public by default). voice_rw
--    references the unqualified `vector` type in DDL, so it needs USAGE on public to
--    resolve it. This grants type resolution ONLY — not access to any public table.
GRANT USAGE ON SCHEMA public TO voice_rw;

-- Done. Next (DEPLOY.md): set the voice_rw password from the mounted secret, then
-- connect as voice_rw and run `bun run migrate`.
