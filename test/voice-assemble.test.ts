import { describe, expect, test } from "bun:test";

import { assemble, hasNegativeDirective } from "../src/voice/assemble.ts";
import type { StyleCard } from "../src/voice/types.ts";

const CARD: StyleCard = {
  targets: {
    sentence_len_mean: 14,
    sentence_len_variance: 40,
    mattr: 0.7,
    punctuation_profile: { em_dash: 0.01 },
    contraction_rate: 0.03,
    emoji_rate: 0.002,
    lowercase_start_rate: 0.4,
    signature_ngrams: ["make sure", "as always"],
  },
  prose: {
    voice_summary: "Direct, collegial technical announcements.",
    habits: ["opens with the ask", "short paragraphs"],
    do_more_of: ["first-person framing"],
  },
};

describe("assemble — order + content (§7)", () => {
  test("fixed order: style card → exemplars → task", () => {
    const out = assemble({ styleCard: CARD, exemplars: ["real msg one"], task: "announce X" });
    const card = out.indexOf("VOICE —");
    const ex = out.indexOf("EXAMPLE 1");
    const task = out.indexOf("TASK:");
    expect(card).toBeGreaterThanOrEqual(0);
    expect(card).toBeLessThan(ex);
    expect(ex).toBeLessThan(task);
    expect(out).toContain("real msg one");
    expect(out).toContain("announce X");
  });

  test("facts section appears when provided", () => {
    const out = assemble({
      styleCard: CARD,
      exemplars: ["m"],
      facts: ["release is Tuesday"],
      task: "t",
    });
    expect(out).toContain("release is Tuesday");
    expect(out.indexOf("release is Tuesday")).toBeLessThan(out.indexOf("TASK:"));
  });

  test("cold-start: no style card section when card is null (§8)", () => {
    const out = assemble({ styleCard: null, exemplars: ["m"], task: "t" });
    expect(out).not.toContain("VOICE —");
    expect(out).toContain("EXAMPLE 1");
  });

  test("retry nudge is appended to the task", () => {
    const out = assemble({
      styleCard: CARD,
      exemplars: ["m"],
      task: "t",
      nudge: "lean in further",
    });
    expect(out).toContain("lean in further");
  });
});

describe("positive framing (§6)", () => {
  test("authored scaffolding contains no negative directives", () => {
    const out = assemble({ styleCard: CARD, exemplars: ["a clean example"], task: "a clean task" });
    expect(hasNegativeDirective(out)).toBe(false);
  });

  test("hasNegativeDirective detects forbidden phrasing", () => {
    expect(hasNegativeDirective("do not use em-dashes")).toBe(true);
    expect(hasNegativeDirective("avoid long sentences")).toBe(true);
    expect(hasNegativeDirective("write in your voice")).toBe(false);
  });
});
