/**
 * MCP tool schemas (spec 06 §4, §5). Zod input + output schemas for the 7 tools.
 * The output of every content verb is the machine-readable gate result
 * (`structuredContent`, §5) so the calling agent enforces "is this really my voice?"
 * in one round-trip. Registers/strictness are closed Zod enums (§4).
 */
import { z } from "zod";
import { REGISTERS } from "../../corpus-record";

export const registerSchema = z.enum(REGISTERS);
export const strictnessSchema = z.enum(["lenient", "standard", "strict"]);
export const sourceSchema = z.enum(["email", "matrix"]);

// Trust-boundary caps: bound input so a caller can't drive unbounded Claude-API /
// sidecar work. Generous vs any real message; tighten with the response caps (§10).
const MAX_TEXT = 100_000;
const MAX_ID = 256;
const MAX_SOURCES = 16;
const id = () => z.string().min(1).max(MAX_ID);
const prob = () => z.number().min(0).max(1);

/** Optional generation knobs (shape is open per spec §10; kept minimal for v1). */
export const knobsSchema = z
  .object({
    grounding_query: z.string().optional(),
    length: z.enum(["short", "medium", "long"]).optional(),
  })
  .optional();

// ── Inputs ──────────────────────────────────────────────────────────────────
export const voiceGenerateInput = z.object({
  brief: z.string().min(1).max(MAX_TEXT),
  voice_id: id(),
  register: registerSchema,
  knobs: knobsSchema,
});

export const voiceRewriteInput = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  voice_id: id(),
  register: registerSchema,
  strictness: strictnessSchema.optional(),
});

export const voiceDeaiInput = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  voice_id: id().optional(), // voice optional (§7 voiceless default)
  // register required: the de-AI engine is register-parameterized and §8 mandates it
  // on every call (§4's shorthand omits it — spec self-inconsistency, flagged).
  register: registerSchema,
  strictness: strictnessSchema.optional(),
});

export const voiceTransformInput = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  from_voice: id().optional(),
  to_voice: id(),
  register: registerSchema,
});

export const voiceAddInput = z.object({
  voice_id: id(),
  sources: z.array(sourceSchema).min(1).max(MAX_SOURCES),
  corpus_ref: z.string().max(MAX_ID).optional(),
  // NOTE: no idempotency_key — MCP Tasks has none (spec §7, acceptance §4); app-side
  // dedup keys on a hash of (voice_id, corpus_ref).
});

export const voiceListInput = z.object({});

export const voiceStatusInput = z.object({ voice_id: id() });

// ── Outputs ─────────────────────────────────────────────────────────────────
/** The gate result every content verb returns (spec §5). */
export const gateResultSchema = z.object({
  text: z.string(),
  verdict: z.enum(["PASS", "REVIEW", "FAIL"]),
  scores: z.object({
    stylometric_similarity: prob(),
    ai_detector_prob: prob(),
    register_fit: prob(),
  }),
  gate: z.object({ passed: z.boolean(), failed_checks: z.array(z.string()) }),
  register: registerSchema,
  voice_id: z.string(),
});

/** voice_deai adds before/after detector probs (informational only, §5). */
export const deaiResultSchema = gateResultSchema.extend({
  ai_detector_prob_before: prob(),
  ai_detector_prob_after: prob(),
});

export const voiceAddResultSchema = z.object({ job_id: z.string() });

export const voiceListResultSchema = z.object({
  voices: z.array(z.object({ voice_id: z.string(), registers_ready: z.array(registerSchema) })),
});

export const voiceStatusResultSchema = z.object({
  voice_id: z.string(),
  registers: z.array(
    z.object({
      register: registerSchema,
      readiness: z.enum(["insufficient", "generation-ready", "profile-grade"]),
      coverage: prob(),
      last_eval: z.string().nullable(),
    }),
  ),
});

export type GateResult = z.infer<typeof gateResultSchema>;
export type DeaiResult = z.infer<typeof deaiResultSchema>;
export type VoiceAddResult = z.infer<typeof voiceAddResultSchema>;
export type VoiceListResult = z.infer<typeof voiceListResultSchema>;
export type VoiceStatusResult = z.infer<typeof voiceStatusResultSchema>;
