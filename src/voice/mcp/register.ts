/**
 * Registration layer (spec 06 §3) — binds the transport-agnostic TOOLS to a server.
 * Kept SDK-agnostic via a structural `ToolRegistrar` so it's unit-testable; the real
 * `@modelcontextprotocol/sdk` `McpServer.registerTool` satisfies the shape behind a
 * thin adapter in the live entry point. Each handler returns both a text block (the
 * JSON result) and `structuredContent` (the typed gate result the agent acts on, §5).
 */
import type { z } from "zod";
import { TOOLS, type ToolAnnotations, type VoiceEngine } from "./tools";

export interface ToolRegistration {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  outputShape: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler(args: unknown): Promise<{
    content: { type: "text"; text: string }[];
    structuredContent: unknown;
  }>;
}

export interface ToolRegistrar {
  register(registration: ToolRegistration): void;
}

/** The raw Zod shape of an object schema (what the MCP SDK's registerTool expects). */
function shapeOf(schema: z.ZodTypeAny): z.ZodRawShape {
  return "shape" in schema ? (schema as unknown as { shape: z.ZodRawShape }).shape : {};
}

/** Register all 7 voice tools with `registrar`, routing each through the engine. */
export function registerVoiceTools(registrar: ToolRegistrar, engine: VoiceEngine): void {
  for (const tool of TOOLS) {
    registrar.register({
      name: tool.name,
      description: tool.description,
      inputShape: shapeOf(tool.inputSchema),
      outputShape: shapeOf(tool.outputSchema),
      annotations: tool.annotations,
      handler: async (args: unknown) => {
        const result = await tool.handle(args, engine); // validates in, strips out
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    });
  }
}
