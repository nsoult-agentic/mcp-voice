/**
 * MCP server binding (spec 06 §3 topology) — adapts the SDK-agnostic registration
 * layer to a real `@modelcontextprotocol/sdk` `McpServer` over stdio. This is the
 * thin transport adapter; the engine + tool logic live behind the injected
 * `VoiceEngine`. Construction-only (no unit tests — verified at the type level by tsc
 * against the SDK and exercised live by an MCP client).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { VERSION } from "../../index";
import { registerVoiceTools, type ToolRegistrar } from "./register";
import type { ToolAnnotations, VoiceEngine } from "./tools";

/**
 * Precise structural view of `McpServer.registerTool` used to register erased Zod
 * shapes. The SDK's own signature infers handler arg types from the input shape; with
 * a generic `ZodRawShape` that inference is "excessively deep" (TS2589). The shapes
 * are already type-erased here, so we call through this cast — the SDK still validates
 * inputs/outputs against the supplied shapes at runtime.
 */
type RegisterTool = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema: z.ZodRawShape;
    annotations: ToolAnnotations;
  },
  cb: (args: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    structuredContent: unknown;
  }>,
) => void;

/** Build an McpServer with all 7 voice tools registered against `engine`. */
export function createMcpServer(engine: VoiceEngine): McpServer {
  const server = new McpServer({ name: "mcp-voice", version: VERSION });
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const registrar: ToolRegistrar = {
    register(reg) {
      registerTool(
        reg.name,
        {
          description: reg.description,
          inputSchema: reg.inputShape,
          outputSchema: reg.outputShape,
          annotations: reg.annotations,
        },
        reg.handler,
      );
    },
  };
  registerVoiceTools(registrar, engine);
  return server;
}

/** Connect the server to stdio (the operator's MCP client transport). */
export async function startStdio(engine: VoiceEngine): Promise<void> {
  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
}
