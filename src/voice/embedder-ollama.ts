/**
 * Ollama embedder (live wiring) — the concrete `Embedder` the storage write path needs.
 *
 * Reuses the EXACT model + endpoint the Second Brain already runs: `nomic-embed-text`
 * (768-d) on the Mac Mini Ollama (172.16.10.50:11434). Nothing to install.
 *
 * v1 (Option A, operator's call): content AND style both use nomic, so the style
 * column is filled with topical vectors. This is fine for now — the primary gate is
 * pure stylometry (not embeddings), and the generation path picks exemplars by
 * recency, not style-similarity. A real style-embedding model is a later upgrade
 * (swap `style` here; the column is already 768-d, matching StyleDistance).
 */
import type { Embedder, Embedders } from "../embedder";

export const NOMIC_MODEL = "nomic-embed-text";
export const NOMIC_DIM = 768;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OllamaEmbedderDeps {
  baseUrl: string;
  model?: string;
  dimensions?: number;
  fetch?: typeof fetch;
  /** A hung Ollama must not stall ingestion/generation. */
  timeoutMs?: number;
}

/** A single Ollama-backed embedder for one model. */
export function createOllamaEmbedder(deps: OllamaEmbedderDeps): Embedder {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");
  const model = deps.model ?? NOMIC_MODEL;
  const dimensions = deps.dimensions ?? NOMIC_DIM;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    dimensions,
    async embed(text: string): Promise<number[]> {
      const res = await doFetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`ollama /api/embeddings → ${res.status}`);
      }
      const embedding = (await res.json())?.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length !== dimensions ||
        !embedding.every((n) => typeof n === "number")
      ) {
        const got = Array.isArray(embedding) ? `${embedding.length} values` : typeof embedding;
        throw new Error(`ollama embedding: expected ${dimensions} numbers, got ${got}`);
      }
      return embedding;
    },
  };
}

/**
 * v1 embedders: content + style both nomic (Option A). Swap `style` for a real style
 * model later without touching the schema (both columns are 768-d).
 */
export function createNomicEmbedders(deps: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Embedders {
  const embedder = createOllamaEmbedder(deps);
  return { content: embedder, style: embedder };
}
