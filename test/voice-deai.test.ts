import { describe, expect, test } from "bun:test";

import { deAI } from "../src/voice/deai/deai.ts";
import { checkMeaning } from "../src/voice/deai/meaning-guard.ts";
import {
  detectHits,
  lexicalPass,
  punctuationPass,
  rhetoricalPass,
} from "../src/voice/deai/passes.ts";
import { REGISTRY_VERSION } from "../src/voice/deai/tells.ts";

describe("deterministic passes", () => {
  test("lexical pass swaps flagged words", () => {
    const out = lexicalPass("Let me delve into this intricate topic", "email");
    expect(out.text).toBe("Let me look into this detailed topic");
    expect(out.hits.map((h) => h.id).sort()).toEqual(["lex.delve", "lex.intricate"]);
  });

  test("rhetorical pass strips scaffolding + openers and tidies spaces", () => {
    const out = rhetoricalPass("Certainly! It's worth noting that the plan works.", "email");
    expect(out.text).toBe("the plan works.");
  });

  test("punctuation pass strips bold in email, thins em-dashes in formal registers", () => {
    const out = punctuationPass("**Note** this — and that — also this — really.", "email");
    expect(out.text).not.toContain("**");
    expect(out.text.split(" — ").length - 1).toBeLessThan(3); // thinned
  });

  test("register sanity: chat keeps its em-dashes (§8.6)", () => {
    const out = punctuationPass("hey i think this works — lets ship it — today", "chat");
    expect(out.text).toBe("hey i think this works — lets ship it — today");
  });

  test("longform keeps bold (genuine emphasis), chat/email strip it", () => {
    expect(punctuationPass("**Heads up**: read this", "longform").text).toContain("**Heads up**");
    expect(punctuationPass("**Heads up**: read this", "chat").text).toBe("Heads up: read this");
  });
});

describe("meaning guard (§5)", () => {
  test("flags dropped numbers / urls / entities", async () => {
    const r = await checkMeaning(
      "Pay $500 by 2026 at https://x.io to New York",
      "Pay soon to somewhere",
    );
    expect(r.ok).toBe(false);
    expect(r.breaches).toContain("number:500");
    expect(r.breaches).toContain("url:https://x.io");
    expect(r.breaches).toContain("entity:New York");
  });

  test("passes when entities/numbers are preserved", async () => {
    const r = await checkMeaning(
      "Ship 5 builds to Acme Corp",
      "We will ship 5 builds to Acme Corp",
    );
    expect(r.ok).toBe(true);
  });

  test("semantic cosine breach via injected embedder", async () => {
    const embedder = {
      embed: async (t: string) => (t.includes("orthogonal") ? [0, 1] : [1, 0]),
    };
    const r = await checkMeaning("base text", "orthogonal text", { embedder });
    expect(r.ok).toBe(false);
    expect(r.breaches.some((b) => b.startsWith("semantic:"))).toBe(true);
  });
});

describe("deAI orchestrator", () => {
  const AI_ISH =
    "It's worth noting that we must delve into this intricate tapestry of ideas. " +
    "This plays a crucial role in our work — and it is a testament to the team.";

  test("targeted, not blind: clean text is returned unchanged (§8.1)", async () => {
    const clean = "The meeting is at noon. Bring the report and we will decide.";
    const r = await deAI(clean, { register: "email" });
    expect(r.text).toBe(clean);
    expect(r.changed).toBe(false);
    expect(r.verdict).toBe("PASS");
  });

  test("reduces human-cue tells and surfaces the registry version (§8.3, §8.5)", async () => {
    const before = detectHits(AI_ISH, "longform").length;
    const r = await deAI(AI_ISH, { register: "longform" });
    expect(r.residual_tells.length).toBeLessThan(before);
    expect(r.changed).toBe(true);
    expect(r.registry_version).toBe(REGISTRY_VERSION);
  });

  test("no detector-gaming: the detector score never changes the verdict (§8.4)", async () => {
    const clean = "Send the file when you can. Thanks for the quick turnaround.";
    const detector = { score: async () => 0.99 }; // screams "AI" but must not gate
    const r = await deAI(clean, { register: "email" }, { detector });
    expect(r.detector_score).toBe(0.99);
    expect(r.verdict).toBe("PASS"); // verdict from checklist+meaning, not the detector
  });

  test("meaning guard rolls back a pass that drops content (§8.2)", async () => {
    // A rogue rhythm rewriter that deletes a number → must be rolled back.
    const rhythm = { rewrite: async () => "Ship builds now" };
    const r = await deAI(
      "Ship 5 builds now",
      { register: "email", strictness: "strict" },
      { rhythm },
    );
    expect(r.rolled_back).toContain("rhythm");
    expect(r.text).toContain("5"); // the number survived
    expect(r.verdict).toBe("REVIEW");
  });

  test("strictness selects the pass set (rhythm only at strict)", async () => {
    const calls: string[] = [];
    const rhythm = {
      rewrite: async (t: string) => {
        calls.push(t);
        return t;
      },
    };
    await deAI("plain text", { register: "email", strictness: "standard" }, { rhythm });
    expect(calls).toHaveLength(0); // standard never invokes rhythm
    await deAI(
      "plain text — with an extra — dash here now",
      { register: "email", strictness: "strict" },
      { rhythm },
    );
    expect(calls.length).toBeGreaterThan(0); // strict does
  });
});
