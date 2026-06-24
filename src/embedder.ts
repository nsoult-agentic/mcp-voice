/**
 * Embedder interface (spec 02, S2).
 *
 * Storage computes embeddings on write, behind a SWAPPABLE interface so the
 * store is testable standalone (tests inject deterministic stubs) and the real
 * models can change without touching the store. Two spaces (spec §5):
 *   - content: nomic-embed-text 768d — topical "what is this about"
 *   - style:   StyleDistance — content-independent "does this sound like them"
 *
 * The real content embedder reuses the Second Brain Ollama path; the real style
 * embedder (StyleDistance) is wired when eval-harness needs it. This module
 * defines only the contract — implementations live behind it.
 */

export interface Embedder {
  /** Embed `text` into a fixed-dimension vector. Throws on failure. */
  embed(text: string): Promise<number[]>;
  /** The output dimension, matching the target column's `vector(dim)`. */
  readonly dimensions: number;
}

/** The pair of embedders the write path needs: topical + stylistic. */
export interface Embedders {
  content: Embedder;
  style: Embedder;
}
