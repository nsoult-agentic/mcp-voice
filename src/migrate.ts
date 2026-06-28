/**
 * One-off migration runner — applies the idempotent `voice.` schema (pgvector ext,
 * register enum, exemplars/profiles tables + partial indexes) to the configured
 * Postgres, then exits. Run once before first use and after any schema change:
 *
 *   docker exec mcp-voice bun run migrate        # against the live NUC DB
 *   DB_PASSWORD=… bun run migrate                 # locally / CI
 *
 * Assumes the one-time bootstrap (ops/bootstrap.sql — role + extension + schema
 * owner) has already run as a superuser; this runner only needs the voice_rw role.
 */
import { close, getDb } from "./db";
import { applyMigrations } from "./schema";

async function main(): Promise<void> {
  await applyMigrations(getDb());
  await close();
  console.log("mcp-voice: migrations applied.");
}

main().catch(async (err: unknown) => {
  console.error("mcp-voice: migration failed:", err);
  await close().catch(() => {});
  process.exit(1);
});
