import { describe, expect, test } from "bun:test";

import { type GenerateDeps, generateInVoice, MAX_ATTEMPTS } from "../src/voice/generate.ts";
import type { RegisterProfile, Verdict } from "../src/voice/types.ts";

const PROFILE: RegisterProfile = {
  version: "v1",
  style_card: {
    targets: {
      sentence_len_mean: 14,
      sentence_len_variance: 30,
      mattr: 0.7,
      punctuation_profile: {},
      contraction_rate: 0.03,
      emoji_rate: 0,
      lowercase_start_rate: 0.4,
      signature_ngrams: ["make sure"],
    },
    prose: { voice_summary: "vs", habits: ["h"], do_more_of: ["d"] },
  },
  exemplar_pool_ref: "ref",
  centroid_ref: "cref",
  readiness: "generation-ready",
};

function verdict(passed: boolean, percentile: number, over: Partial<Verdict> = {}): Verdict {
  return {
    verdict: passed ? "PASS" : "FAIL",
    gate_a: { passed, percentile, cosine_delta: 0, style_cosine: null, threshold_percentile: 0.4 },
    gate_b: { flag: "none", abstained: true },
    register: "email",
    word_count: 50,
    ...over,
  };
}

interface FakeOpts {
  texts: string[]; // one per attempt
  verdicts: Verdict[]; // one per attempt
  profile?: RegisterProfile | null;
}

function deps(fake: FakeOpts): { deps: GenerateDeps; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const d: GenerateDeps = {
    generator: {
      async generate(prompt: string) {
        prompts.push(prompt);
        return fake.texts[i] ?? "fallback";
      },
    },
    evaluator: {
      async evaluate() {
        return fake.verdicts[i++] ?? verdict(false, 0);
      },
    },
    exemplars: {
      async styleExemplars() {
        return ["ex one", "ex two", "ex three"];
      },
      async groundingExemplars() {
        return ["fact"];
      },
    },
    profiles: {
      async getActiveProfile() {
        return fake.profile === undefined ? PROFILE : fake.profile;
      },
    },
  };
  return { deps: d, prompts };
}

const OPTS = { author_id: "operator", register: "email" as const, task: "announce X" };

describe("generateInVoice — gated loop (§7)", () => {
  test("returns on first PASS (no retry)", async () => {
    const { deps: d } = deps({ texts: ["good"], verdicts: [verdict(true, 0.8)] });
    const r = await generateInVoice(d, OPTS);
    expect(r.verdict.verdict).toBe("PASS");
    expect(r.attempts).toBe(1);
    expect(r.cold_start).toBe(false);
  });

  test("retries on Gate-A fail then succeeds", async () => {
    const { deps: d } = deps({
      texts: ["meh", "better"],
      verdicts: [verdict(false, 0.2), verdict(true, 0.7)],
    });
    const r = await generateInVoice(d, OPTS);
    expect(r.attempts).toBe(2);
    expect(r.verdict.verdict).toBe("PASS");
  });

  test("persistent miss returns best-by-Gate-A with verdict surfaced", async () => {
    const { deps: d } = deps({
      texts: ["a", "b", "c"],
      verdicts: [verdict(false, 0.2), verdict(false, 0.55), verdict(false, 0.3)],
    });
    const r = await generateInVoice(d, OPTS);
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.verdict.verdict).not.toBe("PASS");
    expect(r.verdict.gate_a.percentile).toBe(0.55); // the best of the three
  });

  test("retry is gated on Gate A only — a Gate-B-flagged PASS is NOT retried (§7)", async () => {
    // Gate A passes but Gate B flagged high → verdict REVIEW. Must return immediately.
    const { deps: d } = deps({
      texts: ["x", "y"],
      verdicts: [
        verdict(true, 0.7, { verdict: "REVIEW", gate_b: { flag: "high", abstained: false } }),
      ],
    });
    const r = await generateInVoice(d, OPTS);
    expect(r.attempts).toBe(1); // did not retry despite REVIEW
    expect(r.verdict.gate_a.passed).toBe(true);
  });

  test("cold-start: no profile → forced REVIEW, few-shot only, single attempt (§8)", async () => {
    const { deps: d, prompts } = deps({
      texts: ["draft"],
      verdicts: [verdict(true, 0.9)], // even a 'pass' is forced to REVIEW at cold-start
      profile: null,
    });
    const r = await generateInVoice(d, OPTS);
    expect(r.cold_start).toBe(true);
    expect(r.verdict.verdict).toBe("REVIEW");
    expect(r.attempts).toBe(1);
    expect(prompts[0]).not.toContain("VOICE —"); // no style card at cold-start
  });

  test("grounding query pulls facts into the prompt", async () => {
    const { deps: d, prompts } = deps({ texts: ["g"], verdicts: [verdict(true, 0.8)] });
    await generateInVoice(d, { ...OPTS, groundingQuery: "the release date" });
    expect(prompts[0]).toContain("fact");
  });
});
