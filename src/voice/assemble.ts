/**
 * Per-call prompt assembly (spec 04 §7), SIMPLIFIED per the benchmark spike:
 * plain few-shot (~3 exemplars) is as good as the elaborate hybrid, so the default
 * is style card → exemplars → [facts] → task, fixed order.
 *
 * Positive framing only (spec §6, anti-slop): every instruction we author says what
 * TO do, never "don't / avoid". (Operator exemplars are quoted verbatim and are not
 * instructions, so they're exempt.) De-AI tell-removal is a separate spec applied to
 * output, never baked into the generation prompt.
 */
import type { StyleCard } from "./types";

/** Directive phrasings our authored scaffolding must never contain (spec §6 lint). */
const NEGATIVE_DIRECTIVES = [/\bdo not\b/i, /\bdon't\b/i, /\bavoid\b/i, /\bnever\b/i, /\bstop\b/i];

/** True if `text` contains an authored negative directive (used by the §6 lint test). */
export function hasNegativeDirective(text: string): boolean {
  return NEGATIVE_DIRECTIVES.some((re) => re.test(text));
}

/** Render computed targets as POSITIVE cues (never "don't overuse X"). */
function renderTargets(t: StyleCard["targets"]): string {
  const cues: string[] = [];
  cues.push(`Write sentences averaging about ${Math.round(t.sentence_len_mean)} words`);
  if (t.sentence_len_variance > t.sentence_len_mean) {
    cues.push("varying their length freely — some short, some long");
  }
  if (t.contraction_rate > 0.01) {
    cues.push("use contractions naturally");
  }
  if (t.emoji_rate > 0) {
    cues.push("let the occasional emoji through where it fits");
  }
  if (t.lowercase_start_rate > 0.3) {
    cues.push("it's fine to open sentences in lowercase as you often do");
  }
  if (t.signature_ngrams.length > 0) {
    cues.push(`lean on characteristic phrasings like ${t.signature_ngrams.slice(0, 4).join(", ")}`);
  }
  return `${cues.join("; ")}.`;
}

function renderStyleCard(card: StyleCard): string {
  const lines = [
    "VOICE — write as this author:",
    card.prose.voice_summary,
    ...card.prose.habits.map((h) => `- ${h}`),
    ...card.prose.do_more_of.map((d) => `- lean into: ${d}`),
    renderTargets(card.targets),
  ];
  return lines.join("\n");
}

function renderExemplars(exemplars: string[]): string {
  const blocks = exemplars.map((ex, i) => `EXAMPLE ${i + 1}:\n${ex}`);
  return ["Real messages from this author — match their voice:", ...blocks].join("\n\n");
}

export interface AssembleInput {
  styleCard: StyleCard | null; // null ⇒ cold-start (few-shot only, §8)
  exemplars: string[];
  facts?: string[]; // optional topical grounding (content-ranked)
  task: string;
  nudge?: string | undefined; // optional positive retry guidance (from Gate-A sub-scores)
}

/** Assemble the generation prompt in the fixed order (spec §7). */
export function assemble(input: AssembleInput): string {
  const sections: string[] = [];
  if (input.styleCard) {
    sections.push(renderStyleCard(input.styleCard));
  }
  if (input.exemplars.length > 0) {
    sections.push(renderExemplars(input.exemplars));
  }
  if (input.facts && input.facts.length > 0) {
    sections.push(["Relevant facts to weave in (content only):", ...input.facts].join("\n"));
  }
  const task = input.nudge ? `${input.task}\n\n${input.nudge}` : input.task;
  sections.push(`TASK:\n${task}\n\nWrite the message in the author's voice.`);
  return sections.join("\n\n---\n\n");
}
