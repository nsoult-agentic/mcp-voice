/**
 * Register classification (spec §5 step 6, §8).
 *
 * Assigns the final `register` (the style family `voice-model` keys profiles on).
 * Start from the medium→register default, then let a lightweight CONTENT signal
 * override it:
 *   - a long and/or structured message → `longform` (independent of medium)
 *   - a terse one-liner → `chat`
 *
 * Cross-register transfer is risky (domain shift costs up to 55pp of authorship
 * accuracy, research §3 Area 4), so the overrides fire ONLY on a strong signal.
 * On anything ambiguous we keep the medium default rather than guess (§10.5).
 *
 * These thresholds are deterministic heuristics (not ML) and are tunable; the
 * target accuracy is open for the build phase (§10.5) and will be revisited with
 * the claude-voice-benchmark spike.
 */
import { MEDIUM_REGISTER_DEFAULT, type Medium, type Register } from "./corpus-record";

/** A clearly terse one-liner: at most this many words AND a single line → chat. */
const TERSE_MAX_WORDS = 6;
/** A clearly long message → longform regardless of structure. */
const LONGFORM_MIN_WORDS = 120;
/** A structured message (multi-paragraph) needs only this many words → longform. */
const LONGFORM_STRUCTURED_MIN_WORDS = 80;
/** "Structured" means at least this many blank-line-separated paragraphs. */
const LONGFORM_MIN_PARAGRAPHS = 3;

export interface RegisterInput {
  medium: Medium;
  text: string;
  word_count: number;
}

/** Count blank-line-separated paragraphs that carry any non-whitespace content. */
function countParagraphs(text: string): number {
  return text.split(/\n\s*\n/).filter((block) => block.trim() !== "").length;
}

/** True when the cleaned text occupies a single line (no internal newline). */
function isSingleLine(text: string): boolean {
  return !text.trim().includes("\n");
}

/**
 * Classify a unit's register. Returns `longform`/`chat` on a strong content
 * signal, otherwise the medium default — never a low-confidence guess.
 */
export function classifyRegister(input: RegisterInput): Register {
  const { medium, text, word_count } = input;
  const fallback = MEDIUM_REGISTER_DEFAULT[medium];

  // Strong longform signal: clearly long, or moderately long AND structured.
  if (word_count >= LONGFORM_MIN_WORDS) {
    return "longform";
  }
  if (
    countParagraphs(text) >= LONGFORM_MIN_PARAGRAPHS &&
    word_count >= LONGFORM_STRUCTURED_MIN_WORDS
  ) {
    return "longform";
  }

  // Strong terse signal: a short single line.
  if (word_count <= TERSE_MAX_WORDS && isSingleLine(text)) {
    return "chat";
  }

  // Weak signal — keep the medium default rather than guess (§8, §10.5).
  return fallback;
}
