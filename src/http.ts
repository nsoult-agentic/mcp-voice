/**
 * mcp-voice HTTP entry — serves the 7 voice tools over Streamable HTTP, matching the
 * PAI fleet topology (every mcp-* server is reached by the Mac Mini's Claude client
 * through the NPM reverse proxy on the LAN; stdio can't cross the network). The local
 * stdio entry (`src/main.ts`) stays for development.
 *
 * Routes:
 *   GET  /health  — liveness probe (no auth; used by the container healthcheck)
 *   POST /mcp     — MCP Streamable HTTP, stateless; gated by the client-IP allowlist
 *
 * SECURITY: `/mcp` calls Claude (cost) and reads the operator's voice corpus, so it is
 * not world-open. Direct loopback (no X-Forwarded-For) is always allowed; any proxied
 * request must carry an allowlisted client IP (`MCP_ALLOWED_IPS`). A coarse fixed-window
 * rate limit caps request volume. The gate logic lives in `./http-gate` (unit-tested);
 * this mirrors the reviewed mcp-accounting/mcp-email gate.
 *
 * Usage: PORT=8919 SECRETS_DIR=/secrets bun run src/http.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isClientAllowed, isRateLimited, parseAllowedIps, type RateWindow } from "./http-gate";
import { createMcpServer } from "./voice/mcp/server";
import { createVoiceEngineFromEnv } from "./voice/from-env";

const PORT = Number.parseInt(process.env["PORT"] ?? "8919", 10);
const ALLOWED_IPS = parseAllowedIps(process.env["MCP_ALLOWED_IPS"]);

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 120;
const rateWindow: RateWindow = { start: 0, count: 0 };

// Build the live engine ONCE: it owns the Postgres pool, the shared Anthropic client,
// and the in-memory voice_add job store — all of which must persist across requests
// (a per-request rebuild would drop in-flight job state). Each request gets a fresh
// stateless McpServer bound to this shared engine.
const engine = createVoiceEngineFromEnv();

async function handleMcpRequest(req: Request): Promise<Response> {
  if (!isClientAllowed(req.headers.get("x-forwarded-for"), ALLOWED_IPS)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (isRateLimited(rateWindow, Date.now(), WINDOW_MS, MAX_REQUESTS)) {
    return new Response("Rate limit exceeded", { status: 429 });
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
