/**
 * The 7 MCP tools (spec 06 §4) as transport-agnostic definitions: name, Zod
 * input/output schemas, annotations (§6), and a handler that orchestrates across the
 * engine. `defineTool` wraps each handler so it (1) validates input via Zod, (2) calls
 * the typed handler, (3) re-parses the result through the output schema — which both
 * enforces the `structuredContent` contract and STRIPS any field not in the schema
 * (the no-corpus-leakage guarantee, §8). The SDK server registration + the live engine
 * factory are a separate wiring step.
 */
import type { z } from "zod";
import {
  type DeaiResult,
  deaiResultSchema,
  type GateResult,
  gateResultSchema,
  type VoiceAddResult,
  voiceAddInput,
  voiceAddResultSchema,
  voiceDeaiInput,
  voiceGenerateInput,
  type VoiceListResult,
  voiceListInput,
  voiceListResultSchema,
  voiceRewriteInput,
  type VoiceStatusResult,
  voiceStatusInput,
  voiceStatusResultSchema,
  voiceTransformInput,
} from "./schemas";

/** What the tool layer needs from the voice engine (impl is the live-wiring tail). */
export interface VoiceEngine {
  generate(input: z.infer<typeof voiceGenerateInput>): Promise<GateResult>;
  rewrite(input: z.infer<typeof voiceRewriteInput>): Promise<GateResult>;
  deai(input: z.infer<typeof voiceDeaiInput>): Promise<DeaiResult>;
  transform(input: z.infer<typeof voiceTransformInput>): Promise<GateResult>;
  addVoice(input: z.infer<typeof voiceAddInput>): Promise<VoiceAddResult>;
  listVoices(): Promise<VoiceListResult>;
  voiceStatus(input: z.infer<typeof voiceStatusInput>): Promise<VoiceStatusResult>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

interface ToolDef<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  annotations: ToolAnnotations;
  handle(input: I, engine: VoiceEngine): Promise<O>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  annotations: ToolAnnotations;
  handle(input: unknown, engine: VoiceEngine): Promise<unknown>;
}

function defineTool<I, O>(def: ToolDef<I, O>): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
    async handle(input: unknown, engine: VoiceEngine): Promise<unknown> {
      const parsed = def.inputSchema.parse(input); // §9.1 reject bad input
      const result = await def.handle(parsed, engine);
      return def.outputSchema.parse(result); // contract + no-leakage strip (§8, §9.6)
    },
  };
}

// ── Content verbs (read-only, synchronous; gate always present) ───────────────
export const voiceGenerateTool = defineTool({
  name: "voice_generate",
  description:
    "Write fresh text in a stored voice and register; returns the text plus the voice gate.",
  inputSchema: voiceGenerateInput,
  outputSchema: gateResultSchema,
  annotations: { readOnlyHint: true },
  handle: (input, engine) => engine.generate(input),
});

export const voiceRewriteTool = defineTool({
  name: "voice_rewrite",
  description:
    "Re-voice existing text into a stored voice/register, preserving meaning; returns the gate.",
  inputSchema: voiceRewriteInput,
  outputSchema: gateResultSchema,
  annotations: { readOnlyHint: true },
  handle: (input, engine) => engine.rewrite(input),
});

export const voiceDeaiTool = defineTool({
  name: "voice_deai",
  description:
    "Strip AI tells from text (voice optional); returns the gate plus before/after detector probs.",
  inputSchema: voiceDeaiInput,
  outputSchema: deaiResultSchema,
  annotations: { readOnlyHint: true },
  handle: (input, engine) => engine.deai(input),
});

export const voiceTransformTool = defineTool({
  name: "voice_transform",
  description: "Transform text from one voice into another in a given register; returns the gate.",
  inputSchema: voiceTransformInput,
  outputSchema: gateResultSchema,
  annotations: { readOnlyHint: true },
  handle: (input, engine) => engine.transform(input),
});

// ── Voice management ──────────────────────────────────────────────────────────
export const voiceAddTool = defineTool({
  name: "voice_add",
  description:
    "Build/update a voice from sources (async job: ingest → store → profile). Returns a job_id; poll voice_status.",
  inputSchema: voiceAddInput,
  outputSchema: voiceAddResultSchema,
  // Creates/updates a profile — destructive is reserved for delete/overwrite (§6).
  annotations: { destructiveHint: false, idempotentHint: false },
  handle: (input, engine) => engine.addVoice(input),
});

export const voiceListTool = defineTool({
  name: "voice_list",
  description: "List available voices and which registers are ready for each.",
  inputSchema: voiceListInput,
  outputSchema: voiceListResultSchema,
  annotations: { readOnlyHint: true },
  handle: (_input, engine) => engine.listVoices(),
});

export const voiceStatusTool = defineTool({
  name: "voice_status",
  description: "Per-register readiness/coverage/last-eval for one voice.",
  inputSchema: voiceStatusInput,
  outputSchema: voiceStatusResultSchema,
  annotations: { readOnlyHint: true },
  handle: (input, engine) => engine.voiceStatus(input),
});

/** All 7 tools, in surface order (content verbs, then management). */
export const TOOLS: RegisteredTool[] = [
  voiceGenerateTool,
  voiceRewriteTool,
  voiceDeaiTool,
  voiceTransformTool,
  voiceAddTool,
  voiceListTool,
  voiceStatusTool,
];
