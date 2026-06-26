/**
 * One-shot LLM prose extraction for the style card (spec 04 §5 step 3, §4b).
 *
 * Reads a sample of the author's exemplars and returns POSITIVELY-framed prose
 * descriptors (§6): how the voice reads, its habits, what to lean into — never a
 * "don't" list. Output is validated with Zod at the seam; the assemble step also
 * filters any negative directive that slips through (defense in depth).
 *
 * Uses the same injected Claude client as the generator, so it's unit-testable
 * without a network call.
 */
import { z } from "zod";
import type { ClaudeClient } from "./claude-client";
import { DEFAULT_MODEL } from "./claude-client";
import type { StyleCardProse } from "./types";

const ProseSchema = z.object({
  voice_summary: z.string().min(1),
  habits: z.array(z.string()),
  do_more_of: z.array(z.string()),
});

// Compile-time parity with the hand-written type (both directions).
const _a: StyleCardProse = {} as z.infer<typeof ProseSchema>;
const _b: z.infer<typeof ProseSchema> = {} as StyleCardProse;
void _a;
void _b;

const SYSTEM_INSTRUCTION = [
  "You analyze a writer's real messages and describe their voice for a style guide.",
  "Return ONLY a JSON object with these keys:",
  '  "voice_summary": one or two sentences on how this register reads.',
  '  "habits": array of short positive descriptors (e.g. "opens with the ask", "short paragraphs").',
  '  "do_more_of": array of POSITIVE things to lean into — what to do, never what to avoid.',
  "Frame everything as what TO do. Never write a 'don't' / 'avoid' / 'never' list — naming a tic",
  "entrenches it. No prose outside the JSON, no markdown fences.",
].join("\n");

export interface ProseExtractor {
  extract(exemplars: string[]): Promise<StyleCardProse>;
}

export interface ProseExtractorDeps {
  client: ClaudeClient;
  model?: string;
  maxTokens?: number;
}

/** Strip an optional ```json fence so JSON.parse doesn't choke on it. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return trimmed;
}

export function createClaudeProseExtractor(deps: ProseExtractorDeps): ProseExtractor {
  const { client } = deps;
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? 1024;

  return {
    async extract(exemplars: string[]): Promise<StyleCardProse> {
      const examples = exemplars.map((ex, i) => `EXAMPLE ${i + 1}:\n${ex}`).join("\n\n");
      const prompt = `${SYSTEM_INSTRUCTION}\n\n---\n\n${examples}`;
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") {
        throw new Error("prose-extractor: request refused by the model");
      }
      const text = res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
        .trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripFence(text));
      } catch {
        throw new Error("prose-extractor: response was not valid JSON");
      }
      return ProseSchema.parse(parsed);
    },
  };
}
