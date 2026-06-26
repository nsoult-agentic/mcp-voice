/**
 * Claude generator client (spec 04 wiring) — implements the injected `Generator`
 * seam by calling the Anthropic Messages API (`@anthropic-ai/sdk`).
 *
 * Thinking is left OFF by default: the benchmark spike found that natural,
 * first-draft voice (plus the gated retry + de-AI passes) beats heavily-reasoned
 * output, which reads more "AI-polished". The gated loop in generate.ts handles
 * quality; this client's job is to turn an assembled prompt into a candidate.
 *
 * The Anthropic client is injected (structural type) so the orchestration is
 * unit-testable without a network call or an API key.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Generator } from "./generate";

export const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 4096;

/** The slice of the Anthropic SDK surface this client uses (keeps tests SDK-free). */
export interface MessagesApi {
  create(params: {
    model: string;
    max_tokens: number;
    messages: { role: "user"; content: string }[];
  }): Promise<{
    content: { type: string; text?: string }[];
    stop_reason?: string | null;
  }>;
}

export interface ClaudeClient {
  messages: MessagesApi;
}

export interface ClaudeGeneratorDeps {
  client?: ClaudeClient;
  model?: string;
  maxTokens?: number;
}

/** Create a Generator backed by the Anthropic Messages API. */
export function createClaudeGenerator(deps: ClaudeGeneratorDeps = {}): Generator {
  const client = deps.client ?? (new Anthropic() as unknown as ClaudeClient);
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async generate(prompt: string): Promise<string> {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });

      // The model may decline (opus-4-8 can return stop_reason "refusal") — surface
      // it rather than passing an empty/partial draft into the gate.
      if (res.stop_reason === "refusal") {
        throw new Error("claude-generator: request refused by the model");
      }

      const text = res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
        .trim();

      if (text.length === 0) {
        throw new Error(`claude-generator: empty response (stop_reason=${res.stop_reason})`);
      }
      return text;
    },
  };
}
