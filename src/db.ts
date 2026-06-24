/**
 * Postgres connection (spec 02, S1).
 *
 * mcp-voice reuses the existing Second Brain Postgres 17 + pgvector instance, in
 * an ISOLATED `voice.` schema (never the knowledge tables). Connection config
 * mirrors mcp-second-brain: env for host/port/db/user, a file-mounted secret for
 * the password — with a `DB_PASSWORD` env fallback so ephemeral environments
 * (CI's pgvector service container) can supply it without a secrets mount.
 *
 * Lazy singleton pool: created on first use, closed via `close()`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const SECRETS_DIR = process.env["SECRETS_DIR"] ?? "/secrets";

/**
 * Resolve the DB password: `DB_PASSWORD` env wins (CI / ephemeral), else the
 * mounted secret file. Errors are generic — never leak the secret path.
 */
function getDbPassword(): string {
  const fromEnv = process.env["DB_PASSWORD"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const pw = readFileSync(resolve(SECRETS_DIR, "db-password"), "utf-8").trim();
    if (pw.length === 0) {
      throw new Error("Password file is empty");
    }
    return pw;
  } catch {
    throw new Error("Failed to load DB password. Set DB_PASSWORD or mount the secret.");
  }
}

export type Sql = ReturnType<typeof postgres>;

let sql: Sql | null = null;

/** Lazily create (and reuse) the connection pool. */
export function getDb(): Sql {
  if (sql) {
    return sql;
  }
  sql = postgres({
    host: process.env["DB_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(process.env["DB_PORT"] ?? "5432", 10),
    database: process.env["DB_NAME"] ?? "second_brain",
    username: process.env["DB_USER"] ?? "pai",
    password: getDbPassword(),
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
  });
  return sql;
}

/** Close the pool (test teardown / graceful shutdown). */
export async function close(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
