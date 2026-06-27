/**
 * CorpusRecord — the canonical output contract (spec §4).
 *
 * Every ingested unit becomes one immutable record. This is the interface the
 * `storage` spec builds on; changing it is a breaking change. v1 restricts
 * `medium` to `email` + `matrix` (§2 scope) and stores `text_clean` only — no
 * raw blob (D6) and no redacted field (D5). The schema is strict so a stray
 * `text_raw` or `text_redacted` cannot survive parsing.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Mediums in scope: email + matrix (live adapters), plus `slack` + `claude` —
 * imported, PRE-CLEANED operator text (curated Slack export, Claude-chat history).
 * Imported mediums carry no reply/quote boundaries, so the pipeline skips boundary
 * stripping for them (provenance lives in `source_uri`). doc/commit/pr deferred.
 */
const MediumSchema = z.enum(["email", "matrix", "slack", "claude"]);
export type Medium = z.infer<typeof MediumSchema>;

/** Register taxonomy (D1): chat | email | longform. */
const RegisterSchema = z.enum(["chat", "email", "longform"]);
export type Register = z.infer<typeof RegisterSchema>;
/** The register labels as a runtime array (single source of truth; derived from the enum). */
export const REGISTERS = RegisterSchema.options;

/**
 * Default medium→register map (§3): the register a unit takes absent a strong
 * content signal. The content classifier (`register.ts`) may override toward
 * `longform`/`chat`; on a weak signal it falls back to exactly this default.
 */
export const MEDIUM_REGISTER_DEFAULT = {
  email: "email",
  matrix: "chat",
  // Imported sources: curated Slack skews longform, Claude-chat skews chat. The
  // content classifier still overrides on a strong signal (a short Slack note → chat).
  slack: "longform",
  claude: "chat",
} as const satisfies Record<Medium, Register>;

/**
 * The canonical record schema. Zod's default object behavior strips unknown
 * keys, so a stray `text_raw`/`text_redacted` is dropped rather than surviving
 * (D5/D6); `.datetime()` enforces ISO-8601.
 */
export const CorpusRecordSchema = z.object({
  id: z.string().min(1),
  author_id: z.string().min(1),
  medium: MediumSchema,
  register: RegisterSchema,
  source_uri: z.string().min(1),
  thread_id: z.string().nullable(),
  timestamp: z.string().datetime(),
  text_clean: z.string(),
  word_count: z.number().int().nonnegative(),
  dedup_cluster_id: z.string().min(1),
  is_canonical: z.boolean(),
  ingest_version: z.string().min(1),
});

export type CorpusRecord = z.infer<typeof CorpusRecordSchema>;

/** Provenance + content inputs to the stable id hash. */
export interface ComputeIdInput {
  author_id: string;
  medium: Medium;
  source_uri: string;
  content: string;
}

/**
 * Stable content hash of (author_id, medium, source_uri, content) (§4, §10.3).
 * Same provenance + content → same id (idempotent); any change to provenance or
 * content → a different id. The fields are length-prefixed so they cannot be
 * confused across the boundary (e.g. a trailing char migrating between fields).
 */
export function computeId(input: ComputeIdInput): string {
  const parts = [input.author_id, input.medium, input.source_uri, input.content];
  const payload = parts.map((p) => `${p.length}:${p}`).join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
