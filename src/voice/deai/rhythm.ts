/**
 * Pass 3 — rhythm (spec 05 §4.3). The one de-AI pass that genuinely needs an LLM:
 * restructure sentences to raise length variance toward natural human writing (mix of
 * short and long), without paraphrasing away meaning. Gated behind `strict` (DA2) and
 * always followed by the meaning guard (§5), which rolls it back on any breach — so
 * this is best-effort: on a refusal or empty reply it returns the input unchanged
 * (a no-op the orchestrator simply skips), never throwing into the pipeline.
 *
 * Framed as ONE hard-to-fake signal, not "the strongest" (§4.3). The Claude client is
 * injected (same shape as the generator), so it's unit-testable without a network call.
 */
import type { Register } from "../../corpus-record";
import { type ClaudeClient, DEFAULT_MODEL } from "../claude-client";
import type { RhythmRewriter } from "./deai";

const INSTRUCTION = (register: Register): string =>
  [
    "Rewrite the message below so its sentence rhythm reads like natural human writing:",
    "mix short and long sentences, break up any uniform cadence. Keep the meaning, facts,",
    `names, and numbers exactly as they are. Keep a ${register} register. Change only`,
    "sentence structure and length — do not add, remove, or restyle content. Return only",
    "the rewritten message, with no preamble or commentary.",
  ].join(" ");

export interface RhythmRewriterDeps {
  client: ClaudeClient;
  model?: string;
  maxTokens?: number;
}

export function createClaudeRhythmRewriter(deps: RhythmRewriterDeps): RhythmRewriter {
  const { client } = deps;
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? 4096;

  return {
    async rewrite(text: string, register: Register): Promise<string> {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: `${INSTRUCTION(register)}\n\n${text}` }],
      });
      if (res.stop_reason === "refusal") {
        return text; // best-effort: leave the text untouched rather than fail the pass
      }
      const out = res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
        .trim();
      return out.length > 0 ? out : text;
    },
  };
}
