/**
 * The tell registry (spec 05 §3) — a VERSIONED DATA artifact, not hard-coded logic.
 *
 * Tells shift every model generation, so passes iterate this registry rather than
 * embedding a fixed set: adding a tell (new REGISTRY_VERSION) changes behavior with
 * no code change (acceptance §5). Magnitudes use the CORRECTED research numbers
 * (the source had fabricated/miscited figures the adversarial pass caught, §3).
 *
 * `replace`:
 *   - a string  → deterministic per-occurrence remediation (lexical/scaffolding/markdown).
 *   - null      → detect-only: counted for the human-cue checklist but NOT auto-rewritten
 *                 (rhetorical rewrites need the LLM rhythm pass — a later slice).
 * Substitutes here are deliberately plain (voiceless baseline, DA3); voice-anchored
 * corpus substitution is the documented upgrade.
 */
import type { Register } from "../../corpus-record";

export const REGISTRY_VERSION = "2026-06-26.1";

export type TellCategory =
  | "lexical_word"
  | "stock_phrase"
  | "rhetorical_construction"
  | "scaffolding_pattern"
  | "punctuation_markdown";

export interface Tell {
  id: string;
  category: TellCategory;
  /** Case-insensitive by default; the pass compiles this with the `i` flag. */
  detect: string;
  /** Deterministic replacement, or null for detect-only (checklist) tells. */
  replace: string | null;
  /** Positive remediation strategy (what TO do), per §3/§6 framing. */
  remediation: string;
  evidence_ref: string;
  registers: Register[];
  version_added: string;
}

const ALL: Register[] = ["chat", "email", "longform"];
const FORMAL: Register[] = ["email", "longform"];

export const TELL_REGISTRY: readonly Tell[] = [
  // ── lexical_word (corrected magnitudes, §3) ───────────────────────────────
  {
    id: "lex.delve",
    category: "lexical_word",
    detect: "\\bdelve(s|d|ing)?\\b",
    replace: "look",
    remediation: "use a plain verb for examining ('look at', 'go into')",
    evidence_ref: "~19.46/M, ~33.5x human baseline (corrected; not 183/M)",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "lex.intricate",
    category: "lexical_word",
    detect: "\\bintricate(ly)?\\b",
    replace: "detailed",
    remediation: "say 'detailed' or 'complicated' plainly",
    evidence_ref: "~+611% over baseline (verified)",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "lex.underscore",
    category: "lexical_word",
    detect: "\\bunderscore(s|d|ing)?\\b",
    replace: "shows",
    remediation: "use 'shows' / 'points to' instead of 'underscores'",
    evidence_ref: "~+390.65% over baseline (corrected; not +904%)",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "lex.tapestry",
    category: "lexical_word",
    detect: "\\btapestr(y|ies)\\b",
    replace: "mix",
    remediation: "drop the metaphor; name the thing plainly",
    evidence_ref: "high-frequency AI metaphor (verified cue)",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "lex.utilize",
    category: "lexical_word",
    detect: "\\butiliz(e|es|ed|ing)\\b",
    replace: "use",
    remediation: "prefer 'use'",
    evidence_ref: "register-inflation tic",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "lex.myriad",
    category: "lexical_word",
    detect: "\\bmyriad\\b",
    replace: "many",
    remediation: "prefer 'many' / 'lots of'",
    evidence_ref: "elevated-register tic",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  // ── stock_phrase ──────────────────────────────────────────────────────────
  {
    id: "stock.testament",
    category: "stock_phrase",
    detect: "\\b(?:is |stands as )?a testament to\\b",
    replace: "shows",
    remediation: "state what it shows directly",
    evidence_ref: "stock AI flourish",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "stock.vital_role",
    category: "stock_phrase",
    detect: "\\bplays? an? (?:vital|crucial|key|pivotal|significant) role in\\b",
    replace: "matters for",
    remediation: "say it plainly: 'X matters for Y'",
    evidence_ref: "stock AI construction",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "stock.when_it_comes_to",
    category: "stock_phrase",
    detect: "\\bwhen it comes to\\b",
    replace: "for",
    remediation: "use 'for' / 'with'",
    evidence_ref: "filler connective",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "stock.in_the_realm_of",
    category: "stock_phrase",
    detect: "\\bin the realm of\\b",
    replace: "in",
    remediation: "use 'in'",
    evidence_ref: "elevated filler",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  // ── scaffolding_pattern (strip; replace "") ───────────────────────────────
  {
    id: "scaf.worth_noting",
    category: "scaffolding_pattern",
    detect: "\\bit['’]s worth noting that\\s*",
    replace: "",
    remediation: "drop the meta-hedge; just say it",
    evidence_ref: "scaffolding hedge",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "scaf.important_to_note",
    category: "scaffolding_pattern",
    detect: "\\bit['’]s important to note that\\s*",
    replace: "",
    remediation: "drop the meta-hedge",
    evidence_ref: "scaffolding hedge",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "scaf.in_conclusion",
    category: "scaffolding_pattern",
    detect: "\\bin (?:conclusion|summary),?\\s*",
    replace: "",
    remediation: "let the closing stand without a label",
    evidence_ref: "essay-scaffolding closer",
    registers: FORMAL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "scaf.happy_to_help",
    category: "scaffolding_pattern",
    detect: "\\bi['’]?d be happy to (?:help|assist)(?: you)?\\b\\.?\\s*",
    replace: "",
    remediation: "drop the sycophantic offer",
    evidence_ref: "assistant-persona opener",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  {
    id: "scaf.certainly_opener",
    category: "scaffolding_pattern",
    detect: "^(?:certainly|of course|absolutely|great question)[!,.]\\s*",
    replace: "",
    remediation: "open on the substance, not an affirmation",
    evidence_ref: "assistant-persona opener",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  // ── rhetorical_construction (DETECT-ONLY — LLM rhythm pass rewrites these) ─
  {
    id: "rhet.not_just_but",
    category: "rhetorical_construction",
    detect: "\\bnot (?:just|only)\\b[^.!?]{1,60}?\\bbut(?: also)?\\b",
    replace: null,
    remediation: "recast the antithesis as a plain statement",
    evidence_ref: "top non-vocabulary human-detectable cue (verified)",
    registers: ALL,
    version_added: REGISTRY_VERSION,
  },
  // ── punctuation_markdown ──────────────────────────────────────────────────
  {
    id: "punct.bold",
    category: "punctuation_markdown",
    detect: "\\*\\*([^*\\n]+)\\*\\*",
    replace: "$1",
    remediation: "drop inline bold where it reads as machine emphasis",
    evidence_ref: "training-induced markdown overuse",
    // Strip in chat/email (inline bold is unnatural there); keep in longform, where
    // structured emphasis can be genuine.
    registers: ["chat", "email"],
    version_added: REGISTRY_VERSION,
  },
  {
    // Detect-only; the punctuation pass reduces em-dash DENSITY (not per-occurrence),
    // so registers them for the checklist without a blanket replace.
    id: "punct.em_dash",
    category: "punctuation_markdown",
    detect: "\\s—\\s",
    replace: null,
    remediation: "thin spaced em-dashes toward the register's natural rate",
    evidence_ref: "training-induced punctuation overuse (verified)",
    registers: FORMAL,
    version_added: REGISTRY_VERSION,
  },
];

/** Registry entries that apply to a given register. */
export function tellsFor(register: Register): Tell[] {
  return TELL_REGISTRY.filter((t) => t.registers.includes(register));
}
