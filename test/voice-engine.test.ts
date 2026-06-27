import { describe, expect, test } from "bun:test";

import {
  createInMemoryJobStore,
  createVoiceEngine,
  type EngineDeps,
  type ProfileDirectory,
} from "../src/voice/engine.ts";
import type { GenerateDeps } from "../src/voice/generate.ts";
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
      signature_ngrams: [],
    },
    prose: { voice_summary: "vs", habits: [], do_more_of: [] },
  },
  exemplar_pool_ref: "ref",
  centroid_ref: "cref",
  readiness: "generation-ready",
};

function verdict(passed: boolean): Verdict {
  return {
    verdict: passed ? "PASS" : "FAIL",
    gate_a: {
      passed,
      percentile: passed ? 0.8 : 0.2,
      cosine_delta: 0,
      style_cosine: null,
      threshold_percentile: 0.4,
    },
    gate_b: { flag: "none", abstained: true },
    register: "email",
    word_count: 50,
  };
}

/** GenerateDeps whose generator echoes a fixed candidate and records the author_id seen. */
function genDeps(candidate: string, passed = true): { deps: GenerateDeps; seen: string[] } {
  const seen: string[] = [];
  const deps: GenerateDeps = {
    generator: {
      async generate() {
        return candidate;
      },
    },
    evaluator: {
      async evaluate() {
        return verdict(passed);
      },
    },
    exemplars: {
      async styleExemplars() {
        return ["ex"];
      },
      async groundingExemplars() {
        return ["fact"];
      },
    },
    profiles: {
      async getActiveProfile(author_id) {
        seen.push(author_id);
        return PROFILE;
      },
    },
  };
  return { deps, seen };
}

const DIRECTORY: ProfileDirectory = {
  async listVoices() {
    return { voices: [{ voice_id: "operator", registers_ready: ["email"] }] };
  },
  async voiceStatus(voice_id) {
    return {
      voice_id,
      registers: [
        { register: "email", readiness: "generation-ready", coverage: 0.6, last_eval: null },
      ],
    };
  },
};

function engineWith(gd: GenerateDeps, over: Partial<EngineDeps> = {}) {
  const deps: EngineDeps = {
    generate: gd,
    deai: {},
    directory: DIRECTORY,
    jobs: createInMemoryJobStore(),
    buildVoice: async () => {},
    ...over,
  };
  return createVoiceEngine(deps);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("voice engine — content verbs", () => {
  test("generate maps the gated result to the structuredContent contract", async () => {
    const engine = engineWith(genDeps("Hey team, shipping tonight.").deps);
    const r = await engine.generate({
      brief: "announce launch",
      voice_id: "operator",
      register: "email",
    });
    expect(r.text).toBe("Hey team, shipping tonight.");
    expect(r.verdict).toBe("PASS");
    expect(r.scores.stylometric_similarity).toBe(0.8);
    expect(r.gate).toEqual({ passed: true, failed_checks: [] });
    expect(r.voice_id).toBe("operator");
  });

  test("gate.passed never contradicts a REVIEW verdict (Gate-B-flagged pass)", async () => {
    // gate_a passes but gate_b flags → eval-harness verdict REVIEW. gate.passed must
    // be false (derived from verdict), with gate_b surfaced in failed_checks.
    const reviewVerdict: Verdict = {
      verdict: "REVIEW",
      gate_a: {
        passed: true,
        percentile: 0.7,
        cosine_delta: 0,
        style_cosine: null,
        threshold_percentile: 0.4,
      },
      gate_b: { flag: "low", abstained: false },
      register: "email",
      word_count: 50,
    };
    const gd: GenerateDeps = {
      generator: {
        async generate() {
          return "candidate";
        },
      },
      evaluator: {
        async evaluate() {
          return reviewVerdict;
        },
      },
      exemplars: {
        async styleExemplars() {
          return ["ex"];
        },
        async groundingExemplars() {
          return [];
        },
      },
      profiles: {
        async getActiveProfile() {
          return PROFILE;
        },
      },
    };
    const r = await engineWith(gd).generate({
      brief: "x",
      voice_id: "operator",
      register: "email",
    });
    expect(r.verdict).toBe("REVIEW");
    expect(r.gate.passed).toBe(false);
    expect(r.gate.failed_checks).toContain("gate_b");
  });

  test("rewrite flags a meaning breach (dropped number) and downgrades to REVIEW", async () => {
    // generator returns text missing the "5" from the input → meaning guard breach.
    const engine = engineWith(genDeps("Ship builds now").deps);
    const r = await engine.rewrite({
      text: "Ship 5 builds now",
      voice_id: "operator",
      register: "email",
    });
    expect(r.gate.failed_checks).toContain("meaning");
    expect(r.verdict).toBe("REVIEW"); // was PASS, downgraded by the meaning breach
  });

  test("transform generates in the TARGET voice", async () => {
    const gd = genDeps("converted text");
    const engine = engineWith(gd.deps);
    const r = await engine.transform({
      text: "original",
      from_voice: "alice",
      to_voice: "bob",
      register: "email",
    });
    expect(r.voice_id).toBe("bob");
    expect(gd.seen).toContain("bob"); // generation seeded by the target voice
    expect(gd.seen).not.toContain("alice");
  });

  test("deai reports before/after detector probs and a register_fit of 1 (voiceless)", async () => {
    const detector = { score: async (t: string) => (t.includes("delve") ? 0.7 : 0.2) };
    const engine = engineWith(genDeps("x").deps, { deai: { detector } });
    const r = await engine.deai({ text: "Let me delve into this.", register: "email" });
    expect(r.ai_detector_prob_before).toBe(0.7);
    expect(r.ai_detector_prob_after).toBe(0.2); // 'delve' removed → lower detector score
    expect(r.text).not.toContain("delve");
    expect(r.scores.register_fit).toBe(1);
  });
});

describe("voice engine — management", () => {
  test("voice_add returns a job_id and the background build marks it succeeded", async () => {
    const jobs = createInMemoryJobStore();
    const engine = engineWith(genDeps("x").deps, { jobs, buildVoice: async () => {} });
    const { job_id } = await engine.addVoice({ voice_id: "operator", sources: ["email"] });
    expect(job_id).toBe("job_1");
    await tick();
    expect(jobs.get(job_id)?.status).toBe("succeeded");
  });

  test("a failing build marks the job failed with the error", async () => {
    const jobs = createInMemoryJobStore();
    const engine = engineWith(genDeps("x").deps, {
      jobs,
      buildVoice: async () => {
        throw new Error("boom");
      },
    });
    const { job_id } = await engine.addVoice({ voice_id: "operator", sources: ["email"] });
    await tick();
    expect(jobs.get(job_id)).toEqual({ status: "failed", error: "boom" });
  });

  test("list + status delegate to the directory", async () => {
    const engine = engineWith(genDeps("x").deps);
    expect((await engine.listVoices()).voices[0]?.voice_id).toBe("operator");
    expect((await engine.voiceStatus({ voice_id: "bob" })).voice_id).toBe("bob");
  });
});
