/**
 * Meaning-preservation guard (spec 05 §5). After every pass, before accepting it:
 * named entities, quantities, dates, and URLs must be unchanged (extract-and-compare),
 * and (when an embedder is supplied) semantic similarity must stay above threshold.
 * If a pass breaches either, it is rolled back and the text flagged for REVIEW —
 * meaning always wins over tell-removal.
 *
 * The deterministic extract-and-compare runs with zero dependencies; the semantic
 * cosine is optional (injected embedder) so the guard works offline and is the real
 * safety net for the LLM passes added later.
 */
export interface MeaningEmbedder {
  embed(text: string): Promise<number[]>;
}

export interface MeaningCheckOptions {
  embedder?: MeaningEmbedder | undefined;
  /** Minimum cosine to accept a pass when an embedder is supplied. */
  minSimilarity?: number | undefined;
}

export interface MeaningResult {
  ok: boolean;
  breaches: string[];
}

const NUMBER = /\d[\d.,]*\d|\d/g;
const URL = /https?:\/\/[^\s)]+/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
// Multi-word capitalized runs only — single capitalized words (sentence-initial) are
// too noisy to treat as entities deterministically.
const ENTITY = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;

function multiset(text: string, re: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(re)) {
    const key = m[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Items present in `before` that are missing/reduced in `after` (order-insensitive). */
function dropped(before: string, after: string, re: RegExp): string[] {
  const b = multiset(before, re);
  const a = multiset(after, re);
  const out: string[] = [];
  for (const [key, count] of b) {
    if ((a.get(key) ?? 0) < count) {
      out.push(key);
    }
  }
  return out;
}

function cosine(x: number[], y: number[]): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    dot += xi * yi;
    nx += xi * xi;
    ny += yi * yi;
  }
  if (nx === 0 || ny === 0) {
    return 0;
  }
  return dot / (Math.sqrt(nx) * Math.sqrt(ny));
}

const DEFAULT_MIN_SIMILARITY = 0.92;

/**
 * True iff `after` preserves every number, URL, email, and multi-word entity in
 * `before`, and (if an embedder is given) stays semantically close. Returns the
 * specific breaches for logging/REVIEW.
 */
export async function checkMeaning(
  before: string,
  after: string,
  options: MeaningCheckOptions = {},
): Promise<MeaningResult> {
  const breaches: string[] = [];
  for (const [label, re] of [
    ["number", NUMBER],
    ["url", URL],
    ["email", EMAIL],
    ["entity", ENTITY],
  ] as const) {
    for (const lost of dropped(before, after, re)) {
      breaches.push(`${label}:${lost}`);
    }
  }

  if (options.embedder) {
    const [vb, va] = await Promise.all([
      options.embedder.embed(before),
      options.embedder.embed(after),
    ]);
    const sim = cosine(vb, va);
    if (sim < (options.minSimilarity ?? DEFAULT_MIN_SIMILARITY)) {
      breaches.push(`semantic:${sim.toFixed(3)}`);
    }
  }

  return { ok: breaches.length === 0, breaches };
}
