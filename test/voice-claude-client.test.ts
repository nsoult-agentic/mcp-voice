import { describe, expect, test } from "bun:test";

import {
  type ClaudeClient,
  createClaudeGenerator,
  DEFAULT_MODEL,
} from "../src/voice/claude-client.ts";

function clientReturning(
  content: { type: string; text?: string }[],
  stop_reason: string | null = "end_turn",
): { client: ClaudeClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(params) {
        calls.push(params);
        return { content, stop_reason };
      },
    },
  };
  return { client, calls };
}

describe("claude-generator", () => {
  test("returns the concatenated, trimmed text of the response", async () => {
    const { client, calls } = clientReturning([
      { type: "text", text: "  Hey team — " },
      { type: "text", text: "shipping tonight.  " },
    ]);
    const gen = createClaudeGenerator({ client });
    const out = await gen.generate("write the announcement");
    expect(out).toBe("Hey team — shipping tonight.");
    // sends the prompt as a single user message on the default model
    expect(calls[0]).toMatchObject({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "write the announcement" }],
    });
  });

  test("ignores non-text blocks (e.g. thinking)", async () => {
    const { client } = clientReturning([
      { type: "thinking", text: "internal" },
      { type: "text", text: "final" },
    ]);
    const out = await createClaudeGenerator({ client }).generate("p");
    expect(out).toBe("final");
  });

  test("throws on a refusal", async () => {
    const { client } = clientReturning([], "refusal");
    await expect(createClaudeGenerator({ client }).generate("p")).rejects.toThrow(/refused/);
  });

  test("throws on an empty response", async () => {
    const { client } = clientReturning([{ type: "text", text: "   " }], "end_turn");
    await expect(createClaudeGenerator({ client }).generate("p")).rejects.toThrow(/empty/);
  });

  test("honors model + maxTokens overrides", async () => {
    const { client, calls } = clientReturning([{ type: "text", text: "ok" }]);
    await createClaudeGenerator({ client, model: "claude-sonnet-4-6", maxTokens: 256 }).generate(
      "p",
    );
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-4-6", max_tokens: 256 });
  });
});
