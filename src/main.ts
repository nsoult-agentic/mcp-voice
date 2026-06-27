/**
 * mcp-voice server entry. Constructs the live engine from the environment and serves
 * the 7 tools over stdio (the operator's MCP client transport). Run as the container
 * CMD: `bun run src/main.ts`. Requires ANTHROPIC_API_KEY + DB_PASSWORD (env or
 * /secrets), a running eval sidecar, the NUC Postgres, and the Mac Mini Ollama.
 */
import { createVoiceEngineFromEnv } from "./voice/from-env";
import { startStdio } from "./voice/mcp/server";

async function main(): Promise<void> {
  await startStdio(createVoiceEngineFromEnv());
}

main().catch((err: unknown) => {
  console.error("mcp-voice failed to start:", err);
  process.exit(1);
});
