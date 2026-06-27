import { describe, expect, test } from "bun:test";

import { registerVoiceTools, type ToolRegistration } from "../src/voice/mcp/register.ts";
import type { GateResult } from "../src/voice/mcp/schemas.ts";
import type { VoiceEngine } from "../src/voice/mcp/tools.ts";

const GATE: GateResult = {
  text: "hi",
  verdict: "PASS",
  scores: { stylometric_similarity: 0.8, ai_detector_prob: 0.2, register_fit: 0.9 },
  gate: { passed: true, failed_checks: [] },
  register: "email",
  voice_id: "operator",
};

const engine = {
  async generate() {
    return GATE;
  },
} as unknown as VoiceEngine;

function recordingRegistrar() {
  const regs: ToolRegistration[] = [];
  return { registrar: { register: (r: ToolRegistration) => regs.push(r) }, regs };
}

describe("registerVoiceTools", () => {
  test("registers all 7 tools with shapes + annotations", () => {
    const { registrar, regs } = recordingRegistrar();
    registerVoiceTools(registrar, engine);
    expect(regs.map((r) => r.name).sort()).toEqual([
      "voice_add",
      "voice_deai",
      "voice_generate",
      "voice_list",
      "voice_rewrite",
      "voice_status",
      "voice_transform",
    ]);
    const gen = regs.find((r) => r.name === "voice_generate");
    expect(Object.keys(gen?.inputShape ?? {})).toContain("brief");
    expect(Object.keys(gen?.outputShape ?? {})).toContain("verdict");
    expect(regs.find((r) => r.name === "voice_add")?.annotations.destructiveHint).toBe(false);
  });

  test("a handler round-trips through the engine → structuredContent + JSON text", async () => {
    const { registrar, regs } = recordingRegistrar();
    registerVoiceTools(registrar, engine);
    const gen = regs.find((r) => r.name === "voice_generate");
    const out = await gen?.handler({ brief: "announce", voice_id: "operator", register: "email" });
    expect(out?.structuredContent).toEqual(GATE);
    expect(JSON.parse(out?.content[0]?.text ?? "{}")).toEqual(GATE);
  });

  test("a handler rejects malformed input (validation still enforced)", async () => {
    const { registrar, regs } = recordingRegistrar();
    registerVoiceTools(registrar, engine);
    const gen = regs.find((r) => r.name === "voice_generate");
    await expect(gen?.handler({ voice_id: "operator" })).rejects.toThrow();
  });
});
