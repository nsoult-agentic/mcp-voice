import { describe, expect, test } from "bun:test";

import type { ClaudeClient } from "../src/voice/claude-client.ts";
import { createClaudeProseExtractor } from "../src/voice/prose-extractor.ts";

function clientReturning(text: string, stop_reason = "end_turn"): ClaudeClient {
  return {
    messages: {
      async create() {
        return { content: [{ type: "text", text }], stop_reason };
      },
    },
  };
}

const VALID = JSON.stringify({
  voice_summary: "Direct technical announcements.",
  habits: ["opens with the ask"],
  do_more_of: ["first-person framing"],
});

describe("claude prose extractor", () => {
  test("parses a JSON object into StyleCardProse", async () => {
    const prose = await createClaudeProseExtractor({ client: clientReturning(VALID) }).extract([
      "m",
    ]);
    expect(prose.voice_summary).toBe("Direct technical announcements.");
    expect(prose.habits).toEqual(["opens with the ask"]);
  });

  test("tolerates a ```json code fence", async () => {
    const fenced = "```json\n" + VALID + "\n```";
    const prose = await createClaudeProseExtractor({ client: clientReturning(fenced) }).extract([
      "m",
    ]);
    expect(prose.do_more_of).toEqual(["first-person framing"]);
  });

  test("throws on non-JSON output", async () => {
    const ex = createClaudeProseExtractor({ client: clientReturning("here you go: not json") });
    await expect(ex.extract(["m"])).rejects.toThrow(/not valid JSON/);
  });

  test("throws when the schema is violated (missing voice_summary)", async () => {
    const bad = JSON.stringify({ habits: [], do_more_of: [] });
    await expect(
      createClaudeProseExtractor({ client: clientReturning(bad) }).extract(["m"]),
    ).rejects.toThrow();
  });

  test("throws on a refusal", async () => {
    const ex = createClaudeProseExtractor({ client: clientReturning("", "refusal") });
    await expect(ex.extract(["m"])).rejects.toThrow(/refused/);
  });
});
