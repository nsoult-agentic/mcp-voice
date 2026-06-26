/**
 * Deterministic surgical passes (spec 05 §4). Each pass is TARGETED at registry hits
 * — never a wholesale rewrite (that's the line between de-AI and blind paraphrase, §1).
 * Passes are registry-driven: which words/phrases they touch is data, not code.
 *
 * Covered here (the local, $0 half): Pass 1 lexical, Pass 2 rhetorical (scaffolding +
 * stock-phrase strip/replace; the antithesis is detect-only), Pass 4 punctuation. The
 * Pass 3 rhythm rewrite is an LLM step added in a later slice.
 */
import type { Register } from "../../corpus-record";
import { type Tell, tellsFor } from "./tells";

export interface Hit {
  id: string;
  category: Tell["category"];
  count: number;
}

export interface PassResult {
  text: string;
  hits: Hit[];
}

function compile(tell: Tell): RegExp {
  // Case-insensitive, global; no multiline (a `^` opener anchors to text start).
  return new RegExp(tell.detect, "gi");
}

function countMatches(text: string, tell: Tell): number {
  return (text.match(compile(tell)) ?? []).length;
}

/** Detect every applicable tell over `text` (the human-cue checklist input). */
export function detectHits(text: string, register: Register): Hit[] {
  const hits: Hit[] = [];
  for (const tell of tellsFor(register)) {
    const count = countMatches(text, tell);
    if (count > 0) {
      hits.push({ id: tell.id, category: tell.category, count });
    }
  }
  return hits;
}

/** Apply the deterministic `replace` of every matching tell in `tells`. */
function applyReplacements(text: string, tells: Tell[]): PassResult {
  let out = text;
  const hits: Hit[] = [];
  for (const tell of tells) {
    if (tell.replace === null) {
      continue; // detect-only — not auto-rewritten here
    }
    const count = countMatches(out, tell);
    if (count > 0) {
      out = out.replace(compile(tell), tell.replace);
      hits.push({ id: tell.id, category: tell.category, count });
    }
  }
  return { text: out, hits };
}

const byCategory = (register: Register, category: Tell["category"]): Tell[] =>
  tellsFor(register).filter((t) => t.category === category);

/** Pass 1 — lexical word swaps. */
export function lexicalPass(text: string, register: Register): PassResult {
  return applyReplacements(text, byCategory(register, "lexical_word"));
}

/** Pass 2 — strip scaffolding/hedges/openers and replace stock phrases. */
export function rhetoricalPass(text: string, register: Register): PassResult {
  const tells = [
    ...byCategory(register, "scaffolding_pattern"),
    ...byCategory(register, "stock_phrase"),
  ];
  const result = applyReplacements(text, tells);
  // Tidy doubled spaces left by stripped scaffolding, without touching newlines.
  return { ...result, text: result.text.replace(/ {2,}/g, " ").replace(/^ +/gm, "") };
}

/** Em-dash density per 100 words, by register (chat tolerates the most). */
const EM_DASH_RATE: Record<Register, number> = { chat: 5, email: 1, longform: 1.5 };
const SPACED_EM_DASH = " — ";

function thinEmDashes(text: string, register: Register): { text: string; reduced: number } {
  if (register === "chat") {
    return { text, reduced: 0 }; // chat keeps its informal dashes (§8.6)
  }
  const parts = text.split(SPACED_EM_DASH);
  const occurrences = parts.length - 1;
  if (occurrences === 0) {
    return { text, reduced: 0 };
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  const allowance = Math.max(1, Math.round((words / 100) * EM_DASH_RATE[register]));
  if (occurrences <= allowance) {
    return { text, reduced: 0 };
  }
  // Keep the first `allowance` em-dashes; convert the rest to commas.
  let rebuilt = parts[0] ?? "";
  let kept = 0;
  for (let i = 1; i < parts.length; i += 1) {
    if (kept < allowance) {
      rebuilt += SPACED_EM_DASH + parts[i];
      kept += 1;
    } else {
      rebuilt += `, ${parts[i]}`;
    }
  }
  return { text: rebuilt, reduced: occurrences - allowance };
}

/** Pass 4 — normalize punctuation/markdown to the register's natural profile. */
export function punctuationPass(text: string, register: Register): PassResult {
  // Markdown replacements (e.g. inline bold) come from the registry.
  const markdown = byCategory(register, "punctuation_markdown").filter((t) => t.replace !== null);
  const result = applyReplacements(text, markdown);
  const thinned = thinEmDashes(result.text, register);
  const hits = [...result.hits];
  if (thinned.reduced > 0) {
    hits.push({ id: "punct.em_dash", category: "punctuation_markdown", count: thinned.reduced });
  }
  return { text: thinned.text, hits };
}
