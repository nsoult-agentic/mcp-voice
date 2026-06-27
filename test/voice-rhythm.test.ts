import { describe, expect, test } from "bun:test";

import type { ClaudeClient } from "../src/voice/claude-client.ts";
import { deAI } from "../src/voice/deai/deai.ts";
import { createClaudeRhythmRewriter } from "../src/voice/deai/rhythm.ts";

function clientReturning(
  text: string,
  stop_reason = "end_turn",
): { client: ClaudeClient; prompts: string[] } {
  const prompts: string[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(params) {
        prompts.push(params.messages[0]?.content ?? "");
        return { content: [{ type: "text", text }], stop_reason };
      },
    },
  };
  return { client, prompts };
}

describe("claude rhythm rewriter", () => {
  test("returns the rewritten text and passes the register into the prompt", async () => {
    const { client, prompts } = clientReturning("Short. Then a longer, winding sentence follows.");
    const out = await createClaudeRhythmRewriter({ client }).rewrite(
      "uniform text here",
      "longform",
    );
    expect(out).toBe("Short. Then a longer, winding sentence follows.");
    expect(prompts[0]).toContain("longform");
    expect(prompts[0]).toContain("uniform text here");
  });

  test("best-effort: a refusal leaves the text unchanged (no throw)", async () => {
    const { client } = clientReturning("", "refusal");
    expect(await createClaudeRhythmRewriter({ client }).rewrite("keep me", "email")).toBe(
      "keep me",
    );
  });

  test("empty reply leaves the text unchanged", async () => {
    const { client } = clientReturning("   ");
    expect(await createClaudeRhythmRewriter({ client }).rewrite("keep me", "email")).toBe(
      "keep me",
    );
  });
});

describe("rhythm pass integration with deAI (strict)", () => {
  test("the rewrite is adopted when it preserves meaning", async () => {
    // Rewriter restructures rhythm but keeps the number "5" → meaning guard accepts it.
    const { client } = clientReturning("5 builds ship tonight. Quick one.");
    const rhythm = createClaudeRhythmRewriter({ client });
    const r = await deAI(
      "We will ship 5 builds tonight.",
      { register: "longform", strictness: "strict" },
      { rhythm },
    );
    expect(r.text).toBe("5 builds ship tonight. Quick one.");
    expect(r.rolled_back).not.toContain("rhythm");
  });

  test("a throwing rhythm pass is skipped, not fatal (loop robustness)", async () => {
    const rhythm = {
      rewrite: async () => {
        throw new Error("LLM down");
      },
    };
    const r = await deAI("plain text", { register: "email", strictness: "strict" }, { rhythm });
    expect(r.rolled_back).toContain("rhythm");
    expect(r.text).toBe("plain text"); // survived the failure
  });
});
