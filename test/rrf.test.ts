import { describe, expect, test } from "bun:test";

import { fuseRRF } from "../src/rrf.ts";

// Reciprocal Rank Fusion (spec 02 §8). score(id) = Σ_lists weight / (rrfK + rank),
// rank 1-based. Style is weighted primary over content. Pure — no DB. Expected
// values derived by hand from the RRF formula, not read off the implementation.

describe("fuseRRF", () => {
  test("a single list preserves its order", () => {
    expect(fuseRRF([{ ids: ["a", "b", "c"], weight: 1 }])).toEqual(["a", "b", "c"]);
  });

  test("an item appearing in both lists outranks items in only one", () => {
    // y: 1/62 (rank2 of A) + 1/61 (rank1 of B); x: 1/61; z: 1/62 → y, x, z.
    const fused = fuseRRF([
      { ids: ["x", "y"], weight: 1 },
      { ids: ["y", "z"], weight: 1 },
    ]);
    expect(fused).toEqual(["y", "x", "z"]);
  });

  test("style weight dominates content at equal rank", () => {
    // s: 2/61; c: 1/61 → s before c.
    const fused = fuseRRF([
      { ids: ["s"], weight: 2 },
      { ids: ["c"], weight: 1 },
    ]);
    expect(fused).toEqual(["s", "c"]);
  });

  test("exact score ties break deterministically by id (ascending)", () => {
    // a: 1/61 (rank1 A); b: 1/61 (rank1 B) → tie → id ascending.
    const fused = fuseRRF([
      { ids: ["b"], weight: 1 },
      { ids: ["a"], weight: 1 },
    ]);
    expect(fused).toEqual(["a", "b"]);
  });

  test("no lists yields an empty result", () => {
    expect(fuseRRF([])).toEqual([]);
  });

  test("custom rrfK changes the rank discounting but not a single list's order", () => {
    expect(fuseRRF([{ ids: ["a", "b"], weight: 1 }], 1)).toEqual(["a", "b"]);
  });
});
