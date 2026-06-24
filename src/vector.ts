/**
 * pgvector literal formatting (spec 02 §5).
 *
 * Formats a number[] as a Postgres `vector` literal (`[a,b,c]`). The string is
 * passed as a bound parameter to the postgres tagged template and cast with
 * `::vector` in SQL — never string-concatenated into the query. Validates length
 * (against the column's dimension) and finiteness as defense-in-depth, so a
 * malformed embedding fails loudly here rather than corrupting a row.
 */

export const CONTENT_DIM = 768; // nomic-embed-text (reused Second Brain embedder).

/**
 * StyleDistance output dimension (spec §4: `STYLE_DIM`). NAACL-2025 StyleDistance
 * is an mpnet-based style embedder → 768d. CONFIRM against the model card when the
 * real style embedder is wired (eval-harness); change here + the migration if it
 * differs. Kept as one constant so the schema and validation never drift apart.
 */
export const STYLE_DIM = 768;

/**
 * Format `vec` as a pgvector literal, asserting it has exactly `dim` finite
 * components.
 */
export function toVectorLiteral(vec: number[], dim: number): string {
  if (!Array.isArray(vec) || vec.length !== dim) {
    throw new Error(`Vector must have exactly ${dim} dimensions, got ${vec?.length ?? 0}`);
  }
  for (let i = 0; i < vec.length; i += 1) {
    const value = vec[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Vector contains a non-finite value at index ${i}: ${value}`);
    }
  }
  return `[${vec.join(",")}]`;
}

/**
 * Parse a pgvector value read back from Postgres (the driver returns the literal
 * string `[a,b,c]`) into a number[]; returns null for a NULL column.
 */
export function parseVectorLiteral(value: unknown): number[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected a vector literal string, got ${typeof value}`);
  }
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner === "") {
    return [];
  }
  return inner.split(",").map((part) => Number.parseFloat(part));
}
