/**
 * Boundary stripping + safe normalization (spec §5 step 3, §8).
 *
 * The locked guarantee: remove other people's words and machine boilerplate
 * (quoted replies, attribution lines, forwarded blocks, signature trailers) but
 * leave the operator's kept text byte-for-byte identical — case, punctuation,
 * em-dash, emoji, contractions, and internal whitespace all preserved. Standard
 * NLP normalization would destroy exactly the voice signal we capture, so
 * `normalizeSafe` does only mechanical, lossless-of-voice operations.
 *
 * These functions are pure. Slice 1 covers email-shaped boundaries; the Matrix
 * quote/system-line variant is a deferred seam (slice 2).
 */

/**
 * A line that introduces a quoted reply via attribution, e.g.
 * "On Tuesday, John wrote:" / "On Mon, 1 Jun 2026, Jane Doe wrote:".
 * Everything from such a line onward is the prior author, not the operator.
 */
const ATTRIBUTION_RE = /^\s*On\b.*\bwrote:\s*$/;

/** A forwarded-message banner; the forwarded original follows it. */
const FORWARDED_RE = /^\s*-+\s*Forwarded message\s*-+\s*$/i;

/** The RFC 3676 signature delimiter: exactly "-- " (dash dash space). */
const SIGNATURE_RE = /^-- $/;

/** A quoted line (the prior author's text), conventionally prefixed with ">". */
const QUOTE_RE = /^\s*>/;

/**
 * Control characters to strip: C0 range (U+0000–U+001F) and DEL/C1 range
 * (U+007F–U+009F), excluding the whitespace we keep — TAB (U+0009) and
 * LF (U+000A). No visible glyph lives in these ranges.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the purpose.
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * True once `line` begins a region that is no longer the operator's own words:
 * an attribution lead-in, a forwarded banner, a signature delimiter, or a
 * quoted block. Everything from the first such line to the end is dropped.
 */
function isBoundaryStart(line: string): boolean {
  return (
    ATTRIBUTION_RE.test(line) ||
    FORWARDED_RE.test(line) ||
    SIGNATURE_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

/** Drop trailing blank (whitespace-only) lines without touching kept content. */
function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.trim() !== "") {
      break;
    }
    end -= 1;
  }
  return lines.slice(0, end);
}

/**
 * Remove quoted replies, attribution lines, forwarded blocks, and signature
 * trailers, returning only the operator's own lead text. Kept lines are never
 * altered (PRESERVE, §8): case, punctuation, em-dash, emoji, contractions and
 * intra-line whitespace are byte-identical to the input span.
 */
export function stripBoundaries(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (isBoundaryStart(line)) {
      break;
    }
    kept.push(line);
  }
  return trimTrailingBlankLines(kept).join("\n");
}

/**
 * Strip a Matrix rich-reply fallback (§5 step 3, §8). Unlike email, Matrix puts
 * the quoted text FIRST: a leading contiguous run of "> …" lines (the first
 * carrying the "<@mxid>" attribution), then a blank separator, then the
 * operator's actual reply. So the rule is the inverse of email — drop the
 * LEADING quote block and the blank lines after it, keep everything below,
 * byte-identical (PRESERVE, §8). A message with no leading quote is returned
 * untouched; a message that is only a quote yields the empty string.
 */
export function stripMatrixBoundaries(text: string): string {
  const lines = text.split("\n");
  if (lines.length === 0 || !QUOTE_RE.test(lines[0] ?? "")) {
    return text;
  }
  let start = 0;
  while (start < lines.length && QUOTE_RE.test(lines[start] ?? "")) {
    start += 1;
  }
  while (start < lines.length && (lines[start] ?? "").trim() === "") {
    start += 1;
  }
  return trimTrailingBlankLines(lines.slice(start)).join("\n");
}

/**
 * NORMALIZE-only operations (§8): Unicode NFC + control-character removal.
 * Explicitly does NOT lowercase, strip punctuation, or remove emoji — those are
 * voice tokens (PRESERVE). NFC runs via `String.prototype.normalize("NFC")`, so
 * a decomposed "e + U+0301" becomes the precomposed "é".
 */
export function normalizeSafe(text: string): string {
  return text.normalize("NFC").replace(CONTROL_CHAR_RE, "");
}
