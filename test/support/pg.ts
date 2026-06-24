import postgres from "postgres";

/**
 * A DEDICATED Postgres connection for one integration test file.
 *
 * Integration test files must NOT share the app's `getDb()` singleton: bun runs
 * test files in one process, and a shared pool that one file's `afterAll` closes
 * (or recreates) while another file is mid-run leaves the event loop with an open
 * handle (the process never exits → the job hangs). Each file opens its own
 * connection here and `end()`s it in `afterAll`, so files are fully decoupled.
 *
 * Reads the same env as `src/db.ts` (CI's pgvector service provides DB_PASSWORD).
 */
export function testDb() {
  return postgres({
    host: process.env["DB_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(process.env["DB_PORT"] ?? "5432", 10),
    database: process.env["DB_NAME"] ?? "second_brain",
    username: process.env["DB_USER"] ?? "pai",
    password: process.env["DB_PASSWORD"] ?? "",
    max: 5,
    idle_timeout: 5,
    connect_timeout: 10,
  });
}
