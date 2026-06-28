-- ============================================================================
-- mcp-voice — one-time database bootstrap
-- ============================================================================
-- Run ONCE, as a SUPERUSER (pai), against the second_brain database, BEFORE the
-- first deploy. It does the two things the application's own migration cannot do
-- as the least-privilege voice_rw role:
--
--   1. CREATE EXTENSION vector  — installing a non-trusted extension needs superuser.
--   2. CREATE ROLE voice_rw + CREATE SCHEMA voice AUTHORIZATION voice_rw — give the
--      app a dedicated role that owns ONLY the isolated voice. schema (never the
--      knowledge tables).
--
-- After this runs, the app connects as voice_rw and `bun run migrate` creates the
-- tables/indexes (its CREATE EXTENSION/SCHEMA IF NOT EXISTS calls then no-op).
--
-- The voice_rw password is supplied at runtime (never hard-coded here) and MUST
-- match /srv/mcp-voice/secrets/db-password:
--
--   psql -h 127.0.0.1 -U pai -d second_brain \
--        -v voice_pw="$(sudo cat /srv/mcp-voice/secrets/db-password)" \
--        -f ops/bootstrap.sql
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. pgvector extension (shared across schemas; superuser-only to install).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Dedicated least-privilege login role. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'voice_rw') THEN
    EXECUTE format('CREATE ROLE voice_rw LOGIN PASSWORD %L', :'voice_pw');
  ELSE
    EXECUTE format('ALTER ROLE voice_rw LOGIN PASSWORD %L', :'voice_pw');
  END IF;
END
$$;

-- 3. Isolated schema, owned by voice_rw (so it can create its own tables/indexes).
CREATE SCHEMA IF NOT EXISTS voice AUTHORIZATION voice_rw;

-- 4. The vector type lives in the extension's schema (public by default). voice_rw
--    references the unqualified `vector` type in DDL, so it needs USAGE on public to
--    resolve it. This grants type resolution ONLY — not access to any public table.
GRANT USAGE ON SCHEMA public TO voice_rw;

-- Done. Next: connect as voice_rw and run `bun run migrate`.
