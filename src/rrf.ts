/**
 * Reciprocal Rank Fusion (spec 02 §8).
 *
 * Fuses one or more ranked id lists into a single ranking. Each list contributes
 * `weight / (rrfK + rank)` to an id's score, where rank is 1-based (the loop index
 * is 0-based, hence the `+ 1`); scores sum across lists. The retrieval primitive
 * fuses a style-ranked and an (optional) content-
 * ranked list with style weighted PRIMARY, so a stylistically-close exemplar
 * outranks a merely topically-close one (research §3 Area 5).
 *
 * Pure and deterministic: exact-score ties break by id (code-point ascending),
 * never by locale or insertion order.
 */

export interface RankedList {
  ids: string[];
  /** Relative contribution of this list (style > content). */
  weight: number;
}

/** The standard RRF damping constant (spec §8). */
const DEFAULT_RRF_K = 60;

/** Fuse ranked lists into a single id ranking, best first. */
export function fuseRRF(lists: RankedList[], rrfK: number = DEFAULT_RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const { ids, weight } of lists) {
    for (let rank = 0; rank < ids.length; rank += 1) {
      const id = ids[rank] as string;
      scores.set(id, (scores.get(id) ?? 0) + weight / (rrfK + rank + 1));
    }
  }
  return [...scores.keys()].sort((a, b) => {
    const delta = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (delta !== 0) {
      return delta;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
