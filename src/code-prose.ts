/**
 * Code/prose split (spec §5 step 4, §2).
 *
 * Embedded code is not natural-language voice, so it is excluded from the prose
 * corpus. v1 removes FENCED code blocks (lines delimited by ``` , optionally with
 * a language tag); inline `code` spans are kept, because removing them mid-
 * sentence would damage the surrounding voice and grammar.
 *
 * PRESERVE (§8): a message with no fence is returned byte-identical. When a fence
 * IS removed, the gap it leaves is tidied — leading/trailing blank lines are
 * dropped and a run of blank lines is collapsed to a single paragraph break — so
 * code removal doesn't leave ragged whitespace. Prose lines themselves are never
 * altered. An all-code message reduces to the empty string (the pipeline then
 * drops it, as it carries no voice).
 */

/** A fence line: ``` optionally followed by a language tag, possibly indented. */
const FENCE_RE = /^\s*```/;

/**
 * Collapse the whitespace left behind by removed code: drop leading/trailing
 * blank lines and squeeze any run of blank lines down to one. Only applied when
 * a fence was actually removed, so fence-free prose stays byte-identical.
 */
function tidyGaps(lines: string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    const isBlank = line.trim() === "";
    const prevBlank = kept.length === 0 || (kept[kept.length - 1] ?? "").trim() === "";
    if (isBlank && prevBlank) {
      continue; // skip leading blanks and collapse blank runs to one.
    }
    kept.push(line);
  }
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") {
    kept.pop();
  }
  return kept.join("\n");
}

/**
 * Remove fenced code blocks from `text`, returning prose only. Fence-free text is
 * returned unchanged. An unterminated fence drops everything from the fence to
 * the end (the remainder is inside an open code block).
 */
export function stripCode(text: string): string {
  const lines = text.split("\n");
  const prose: string[] = [];
  let inCode = false;
  let removed = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inCode = !inCode;
      removed = true;
      continue; // drop the fence line itself.
    }
    if (inCode) {
      removed = true;
      continue; // drop code content.
    }
    prose.push(line);
  }
  return removed ? tidyGaps(prose) : text;
}
