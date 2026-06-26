import { describe, expect, test } from "bun:test";

import { voiceAddInput } from "../src/voice/mcp/schemas.ts";
import type { GateResult } from "../src/voice/mcp/schemas.ts";
import {
  TOOLS,
  type VoiceEngine,
  voiceAddTool,
  voiceDeaiTool,
  voiceGenerateTool,
  voiceStatusTool,
} from "../src/voice/mcp/tools.ts";

const GATE: GateResult = {
  text: "hi there",
  verdict: "PASS",
  scores: { stylometric_similarity: 0.8, ai_detector_prob: 0.2, register_fit: 0.9 },
  gate: { passed: true, failed_checks: [] },
  register: "email",
  voice_id: "operator",
};

function fakeEngine(over: Partial<VoiceEngine> = {}): VoiceEngine {
  return {
    // engine deliberately leaks a raw-corpus field to prove the handler strips it
    async generate() {
      return { ...GATE, _exemplars: ["raw private corpus text"] } as GateResult;
    },
    async rewrite() {
      return GATE;
    },
    async deai() {
      return { ...GATE, ai_detector_prob_before: 0.7, ai_detector_prob_after: 0.2 };
    },
    async transform() {
      return GATE;
    },
    async addVoice() {
      return { job_id: "job_123" };
    },
    async listVoices() {
      return { voices: [{ voice_id: "operator", registers_ready: ["email"] }] };
    },
    async voiceStatus() {
      return {
        voice_id: "operator",
        registers: [
          { register: "email", readiness: "generation-ready", coverage: 0.6, last_eval: null },
        ],
      };
    },
    ...over,
  };
}

const GEN_INPUT = { brief: "announce the launch", voice_id: "operator", register: "email" };

describe("MCP tool surface (spec 06)", () => {
  test("§9.1 rejects malformed input via Zod", async () => {
    await expect(
      voiceGenerateTool.handle({ voice_id: "operator" }, fakeEngine()),
    ).rejects.toThrow();
    await expect(
      voiceGenerateTool.handle({ ...GEN_INPUT, register: "sms" }, fakeEngine()),
    ).rejects.toThrow();
  });

  test("§9.2 every content verb returns verdict + gate (no bypass)", async () => {
    const out = (await voiceGenerateTool.handle(GEN_INPUT, fakeEngine())) as GateResult;
    expect(out.verdict).toBe("PASS");
    expect(out.gate).toEqual({ passed: true, failed_checks: [] });
    expect(out.scores.stylometric_similarity).toBe(0.8);
  });

  test("§9.6 no corpus leakage — fields outside the output schema are stripped", async () => {
    const out = await voiceGenerateTool.handle(GEN_INPUT, fakeEngine());
    expect(Object.keys(out as object)).not.toContain("_exemplars");
  });

  test("§9.3 annotations: content verbs read-only; voice_add non-destructive/non-idempotent", () => {
    for (const t of TOOLS.filter((x) => x.name !== "voice_add")) {
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    expect(voiceAddTool.annotations.readOnlyHint).toBeUndefined();
    expect(voiceAddTool.annotations.destructiveHint).toBe(false);
    expect(voiceAddTool.annotations.idempotentHint).toBe(false);
  });

  test("§9.4 voice_add has no idempotency_key (stripped, not part of the schema)", () => {
    const parsed = voiceAddInput.parse({
      voice_id: "operator",
      sources: ["email"],
      idempotency_key: "should-not-exist",
    });
    expect(parsed).not.toHaveProperty("idempotency_key");
  });

  test("§9.5 voice_add returns a job_id; voice_status reflects readiness", async () => {
    const add = await voiceAddTool.handle(
      { voice_id: "operator", sources: ["email"] },
      fakeEngine(),
    );
    expect(add).toEqual({ job_id: "job_123" });
    const status = (await voiceStatusTool.handle(
      { voice_id: "operator" },
      fakeEngine(),
    )) as Awaited<ReturnType<VoiceEngine["voiceStatus"]>>;
    expect(status.registers[0]?.readiness).toBe("generation-ready");
  });

  test("voice_deai surfaces before/after detector probs (advisory)", async () => {
    const out = (await voiceDeaiTool.handle(
      { text: "delve into this", voice_id: "operator", register: "email" },
      fakeEngine(),
    )) as Awaited<ReturnType<VoiceEngine["deai"]>>;
    expect(out.ai_detector_prob_before).toBe(0.7);
    expect(out.ai_detector_prob_after).toBe(0.2);
  });

  test("§9.7 stateless: identical calls produce identical results", async () => {
    const a = await voiceGenerateTool.handle(GEN_INPUT, fakeEngine());
    const b = await voiceGenerateTool.handle(GEN_INPUT, fakeEngine());
    expect(a).toEqual(b);
  });

  test("exactly the 7 specified tools are exposed", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "voice_add",
      "voice_deai",
      "voice_generate",
      "voice_list",
      "voice_rewrite",
      "voice_status",
      "voice_transform",
    ]);
  });
});
