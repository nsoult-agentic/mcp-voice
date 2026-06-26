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

/** Optional generation knobs (shape is open per spec §10; kept minimal for v1). */
export const knobsSchema = z
  .object({
    grounding_query: z.string().optional(),
    length: z.enum(["short", "medium", "long"]).optional(),
  })
  .optional();

// ── Inputs ──────────────────────────────────────────────────────────────────
export const voiceGenerateInput = z.object({
  brief: z.string().min(1),
  voice_id: z.string().min(1),
  register: registerSchema,
  knobs: knobsSchema,
});

export const voiceRewriteInput = z.object({
  text: z.string().min(1),
  voice_id: z.string().min(1),
  register: registerSchema,
  strictness: strictnessSchema.optional(),
});

export const voiceDeaiInput = z.object({
  text: z.string().min(1),
  voice_id: z.string().min(1).optional(), // voice optional (§7 voiceless default)
  register: registerSchema,
  strictness: strictnessSchema.optional(),
});

export const voiceTransformInput = z.object({
  text: z.string().min(1),
  from_voice: z.string().min(1).optional(),
  to_voice: z.string().min(1),
  register: registerSchema,
});

export const voiceAddInput = z.object({
  voice_id: z.string().min(1),
  sources: z.array(sourceSchema).min(1),
  corpus_ref: z.string().optional(),
  // NOTE: no idempotency_key — MCP Tasks has none (spec §7, acceptance §4); app-side
  // dedup keys on a hash of (voice_id, corpus_ref).
});

export const voiceListInput = z.object({});

export const voiceStatusInput = z.object({ voice_id: z.string().min(1) });

// ── Outputs ─────────────────────────────────────────────────────────────────
/** The gate result every content verb returns (spec §5). */
export const gateResultSchema = z.object({
  text: z.string(),
  verdict: z.enum(["PASS", "REVIEW", "FAIL"]),
  scores: z.object({
    stylometric_similarity: z.number(),
    ai_detector_prob: z.number(),
    register_fit: z.number(),
  }),
  gate: z.object({ passed: z.boolean(), failed_checks: z.array(z.string()) }),
  register: registerSchema,
  voice_id: z.string(),
});

/** voice_deai adds before/after detector probs (informational only, §5). */
export const deaiResultSchema = gateResultSchema.extend({
  ai_detector_prob_before: z.number(),
  ai_detector_prob_after: z.number(),
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
      coverage: z.number(),
      last_eval: z.string().nullable(),
    }),
  ),
});

export type GateResult = z.infer<typeof gateResultSchema>;
export type DeaiResult = z.infer<typeof deaiResultSchema>;
export type VoiceAddResult = z.infer<typeof voiceAddResultSchema>;
export type VoiceListResult = z.infer<typeof voiceListResultSchema>;
export type VoiceStatusResult = z.infer<typeof voiceStatusResultSchema>;
