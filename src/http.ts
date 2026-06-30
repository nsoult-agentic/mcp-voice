/**
 * mcp-voice HTTP entry — serves the 7 voice tools over Streamable HTTP, matching the
 * PAI fleet topology (every mcp-* server is reached by the Mac Mini's Claude client
 * through the NPM reverse proxy on the LAN; stdio can't cross the network). The local
 * stdio entry (`src/main.ts`) stays for development.
 *
 * Routes:
 *   GET  /health  — liveness probe (no auth; used by the container healthcheck)
 *   POST /mcp     — MCP Streamable HTTP, stateless; rate-limited (no app access control)
 *
 * SECURITY: access control is enforced solely at the NPM reverse proxy (fleet policy,
 * second-brain #2526). The container binds 127.0.0.1 only and is reachable just via that
 * proxy (which holds the IP allowlist) or loopback, so every request the app receives is
 * already trusted — the app does NOT gate access itself. A coarse fixed-window rate limit
 * still caps request volume as abuse protection (Claude cost). That logic lives in
 * `./http-gate` (unit-tested).
 *
 * Usage: PORT=8919 SECRETS_DIR=/secrets bun run src/http.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpGate, type RateWindow } from "./http-gate";
import { createMcpServer } from "./voice/mcp/server";
import { createVoiceEngineFromEnv } from "./voice/from-env";

const PORT = Number.parseInt(process.env["PORT"] ?? "8919", 10);

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 120;
const rateWindow: RateWindow = { start: 0, count: 0 };

// Build the live engine ONCE: it owns the Postgres pool, the shared Anthropic client,
// and the in-memory voice_add job store — all of which must persist across requests
// (a per-request rebuild would drop in-flight job state). Each request gets a fresh
// stateless McpServer bound to this shared engine.
const engine = createVoiceEngineFromEnv();

async function handleMcpRequest(req: Request): Promise<Response> {
  // The proxy (not the app) decides access; here we only apply abuse protection. The
  // request is intentionally NOT inspected for its origin / X-Forwarded-For.
  const rejection = mcpGate(req, rateWindow, Date.now(), WINDOW_MS, MAX_REQUESTS);
  if (rejection !== null) {
    return rejection;
  }
  const server: McpServer = createMcpServer(engine);
  // Stateless mode: omitting sessionIdGenerator leaves it undefined (no sessions).
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(req);
}

const httpServer = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  // voice_generate runs a gated loop of Claude calls and buffers the whole response,
  // so the socket can sit silent for far longer than Bun's 10s default idle timeout —
  // which would drop the connection mid-generation (ECONNRESET). Raise it to the max.
  idleTimeout: 255,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "mcp-voice" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/mcp") {
      return handleMcpRequest(req);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`mcp-voice listening on http://0.0.0.0:${PORT}/mcp`);

process.on("SIGTERM", () => {
  httpServer.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  httpServer.stop();
  process.exit(0);
});
