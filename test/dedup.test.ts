import { describe, expect, test } from "bun:test";

import { dedup, type DedupItem } from "../src/dedup.ts";

// Near-duplicate dedup (spec §5 step 5, §8): MinHash + LSH over 5-gram shingles,
// Jaccard ≈ 0.75, KEEP-EARLIEST canonical (D4). Records sharing a cluster get a
// shared dedup_cluster_id; only the earliest is is_canonical. Shingling folds
// case/whitespace (those are detection-only — the STORED text is never touched),
// so a draft vs sent version differing only in case/spacing collapses.

// A ≥39-word body so a single interior word change keeps Jaccard ≥ 0.75
// (one changed word disturbs ≤5 of the S=N−4 shingles → (S−5)/(S+5) ≥ 0.75
// once S ≥ 35, i.e. N ≥ 39). Independently picked, not read off the impl.
const LONG_BASE =
  "we shipped the new ingestion pipeline today and it finally handles the matrix adapter cleanly " +
  "so the corpus stays the operators own words with quoted replies and signatures stripped out " +
  "before anything downstream ever sees a single contaminated sentence from someone else entirely";
const LONG_ONE_WORD_CHANGED = LONG_BASE.replace("today", "tonight");

function item(id: string, text: string, timestamp: string): DedupItem {
  return { id, text, timestamp };
}

describe("dedup — clustering & keep-earliest (§8)", () => {
  test("a singleton is its own cluster and canonical", () => {
    const result = dedup([
      item("a", "a wholly unique one-off message", "2026-06-01T00:00:00.000Z"),
    ]);
    expect(result.get("a")).toEqual({ dedup_cluster_id: "a", is_canonical: true });
  });

  test("two texts identical except case + whitespace collapse to one cluster", () => {
    const items = [
      item("late", "Yeah,  I'll   have them over to you tonight!", "2026-06-02T10:00:00.000Z"),
      item("early", "yeah, i'll have them over to you tonight!", "2026-06-01T09:00:00.000Z"),
    ];
    const result = dedup(items);
    // Earliest timestamp wins as canonical; both share its id as cluster id.
    expect(result.get("early")).toEqual({ dedup_cluster_id: "early", is_canonical: true });
    expect(result.get("late")).toEqual({ dedup_cluster_id: "early", is_canonical: false });
  });

  test("a near-duplicate above threshold (one word changed in a long body) collapses", () => {
    const items = [
      item("draft", LONG_BASE, "2026-06-05T08:00:00.000Z"),
      item("sent", LONG_ONE_WORD_CHANGED, "2026-06-05T08:05:00.000Z"),
    ];
    const result = dedup(items);
    expect(result.get("draft")?.is_canonical).toBe(true);
    expect(result.get("sent")?.is_canonical).toBe(false);
    expect(result.get("sent")?.dedup_cluster_id).toBe("draft");
  });

  test("texts sharing only partial content (Jaccard < 0.75) stay separate", () => {
    const items = [
      item(
        "x",
        "the quick brown fox jumps over the lazy dog every single morning",
        "2026-06-01T00:00:00.000Z",
      ),
      item(
        "y",
        "the quick brown fox swims across the wide river every single evening",
        "2026-06-02T00:00:00.000Z",
      ),
    ];
    const result = dedup(items);
    expect(result.get("x")).toEqual({ dedup_cluster_id: "x", is_canonical: true });
    expect(result.get("y")).toEqual({ dedup_cluster_id: "y", is_canonical: true });
  });

  test("unrelated texts stay in separate singleton clusters", () => {
    const items = [
      item("p", "lunch at one tomorrow?", "2026-06-01T00:00:00.000Z"),
      item("q", "the deployment finished and all green", "2026-06-02T00:00:00.000Z"),
    ];
    const result = dedup(items);
    expect(result.get("p")?.dedup_cluster_id).toBe("p");
    expect(result.get("q")?.dedup_cluster_id).toBe("q");
    expect(result.get("p")?.is_canonical).toBe(true);
    expect(result.get("q")?.is_canonical).toBe(true);
  });

  test("keep-earliest holds across a 3-member cluster", () => {
    const base =
      "thanks so much for sorting this out i really appreciate the quick turnaround on it";
    const items = [
      item("mid", base.toUpperCase(), "2026-06-02T00:00:00.000Z"),
      item("oldest", base, "2026-06-01T00:00:00.000Z"),
      item("newest", `  ${base}  `, "2026-06-03T00:00:00.000Z"),
    ];
    const result = dedup(items);
    expect(result.get("oldest")).toEqual({ dedup_cluster_id: "oldest", is_canonical: true });
    expect(result.get("mid")).toEqual({ dedup_cluster_id: "oldest", is_canonical: false });
    expect(result.get("newest")).toEqual({ dedup_cluster_id: "oldest", is_canonical: false });
  });

  test("equal timestamps tie-break deterministically by id (ascending)", () => {
    const text = "exactly the same content sent twice at the very same instant somehow";
    const ts = "2026-06-01T00:00:00.000Z";
    const result = dedup([item("bbb", text, ts), item("aaa", text, ts)]);
    expect(result.get("aaa")?.is_canonical).toBe(true);
    expect(result.get("bbb")?.is_canonical).toBe(false);
    expect(result.get("bbb")?.dedup_cluster_id).toBe("aaa");
  });
});
