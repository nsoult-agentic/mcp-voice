/**
 * De-AI orchestrator (spec 05 §4–§6). Runs the strictness-selected passes
 * least→most invasive; after each, the meaning guard (§5) either accepts the pass
 * or rolls it back (meaning always wins). The verdict is the human-cue checklist +
 * meaning — NOT the detector: the AI-detector score is advisory, logged, and the
 * loop NEVER iterates against it (Goodhart anti-goal, §2/§6, acceptance §4).
 *
 * Conservative by default (DA2): standard runs passes 1/2/4; the invasive rhythm
 * pass (3, an injected LLM step) only at strict. Voiceless by default (DA3).
 */
import type { Register } from "../../corpus-record";
import { checkMeaning, type MeaningEmbedder } from "./meaning-guard";
import { detectHits, type Hit, lexicalPass, punctuationPass, rhetoricalPass } from "./passes";
import { REGISTRY_VERSION } from "./tells";

export type DeaiStrictness = "lenient" | "standard" | "strict";

/** Optional injected AI detector — its score is logged, never gates (anti-goal). */
export interface AiDetector {
  score(text: string): Promise<number>;
}

/** Optional injected LLM rhythm rewrite (Pass 3) — only consulted at strict. */
export interface RhythmRewriter {
  rewrite(text: string, register: Register): Promise<string>;
}

export interface DeaiDeps {
  embedder?: MeaningEmbedder;
  detector?: AiDetector;
  rhythm?: RhythmRewriter;
}

export interface DeaiOptions {
  register: Register;
  strictness?: DeaiStrictness;
}

export interface DeaiResult {
  text: string;
  verdict: "PASS" | "REVIEW";
  residual_tells: Hit[];
  rolled_back: string[];
  meaning_breaches: string[];
  detector_score: number | null; // advisory only
  registry_version: string;
  changed: boolean;
}

interface Pass {
  name: string;
  run(text: string, register: Register): Promise<{ text: string }> | { text: string };
}

function passSet(strictness: DeaiStrictness, rhythm?: RhythmRewriter): Pass[] {
  const lexical: Pass = { name: "lexical", run: lexicalPass };
  const rhetorical: Pass = { name: "rhetorical", run: rhetoricalPass };
  const punctuation: Pass = { name: "punctuation", run: punctuationPass };
  if (strictness === "lenient") {
    return [lexical, rhetorical];
  }
  if (strictness === "standard") {
    return [lexical, rhetorical, punctuation];
  }
  // strict — adds the invasive rhythm pass (3) before punctuation, if an LLM is wired.
  const passes: Pass[] = [lexical, rhetorical];
  if (rhythm) {
    passes.push({ name: "rhythm", run: (t, r) => rhythm.rewrite(t, r).then((text) => ({ text })) });
  }
  passes.push(punctuation);
  return passes;
}

export async function deAI(
  text: string,
  options: DeaiOptions,
  deps: DeaiDeps = {},
): Promise<DeaiResult> {
  const register = options.register;
  const strictness = options.strictness ?? "standard";

  let current = text;
  const rolledBack: string[] = [];
  for (const pass of passSet(strictness, deps.rhythm)) {
    const result = await pass.run(current, register);
    if (result.text === current) {
      continue; // pass changed nothing
    }
    // §5: accept the pass only if meaning is preserved, else roll it back.
    const meaning = await checkMeaning(current, result.text, { embedder: deps.embedder });
    if (meaning.ok) {
      current = result.text;
    } else {
      rolledBack.push(pass.name);
    }
  }

  const residual = detectHits(current, register);
  // Net meaning check (original → final), for the verdict + breach log.
  const netMeaning = await checkMeaning(text, current, { embedder: deps.embedder });
  // Detector is advisory ONLY — computed for logging, never consulted for the verdict.
  const detectorScore = deps.detector ? await deps.detector.score(current) : null;

  const verdict: DeaiResult["verdict"] =
    netMeaning.ok && rolledBack.length === 0 && residual.length === 0 ? "PASS" : "REVIEW";

  return {
    text: current,
    verdict,
    residual_tells: residual,
    rolled_back: rolledBack,
    meaning_breaches: netMeaning.breaches,
    detector_score: detectorScore,
    registry_version: REGISTRY_VERSION,
    changed: current !== text,
  };
}
