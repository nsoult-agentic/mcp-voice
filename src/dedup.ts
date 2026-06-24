/**
 * Near-duplicate dedup (spec §5 step 5, §8).
 *
 * MinHash + LSH over word 5-gram shingles, Jaccard threshold ≈ 0.75,
 * KEEP-EARLIEST canonical (D4). Records that are near-duplicates share a
 * `dedup_cluster_id`; only the earliest (the canonical) is `is_canonical`.
 *
 * Design: MinHash + LSH does BLOCKING (cheaply surfaces candidate pairs), and an
 * EXACT Jaccard over the shingle sets makes the keep/drop DECISION. So the 0.75
 * threshold is exact and deterministic — LSH only affects which pairs we bother
 * to check, never the verdict. Everything is seeded deterministically (no RNG),
 * so the same input always yields the same clustering (idempotency, §10.3).
 *
 * Shingling folds case and whitespace because those are DETECTION-only inputs —
 * the stored `text_clean` is never touched here. A draft vs sent version that
 * differs only in casing/spacing therefore collapses to one canonical record.
 */

/** A record participating in dedup. `text` is the cleaned text; `id` is stable. */
export interface DedupItem {
  id: string;
  text: string;
  timestamp: string;
}

/** Per-item dedup outcome: which cluster it belongs to and whether it leads it. */
export interface DedupResult {
  dedup_cluster_id: string;
  is_canonical: boolean;
}

export interface DedupOptions {
  /** Jaccard cutoff for "near-duplicate". Tunable; defaults to the spec's 0.75. */
  threshold?: number;
}

const SHINGLE_K = 5;
const NUM_PERM = 128;
const LSH_ROWS = 4;
const LSH_BANDS = NUM_PERM / LSH_ROWS; // 32 bands × 4 rows = 128 permutations.
const DEFAULT_THRESHOLD = 0.75;
const UINT32 = 0xff_ff_ff_ff;

/** FNV-1a 32-bit hash of a string → uint32. Deterministic, fast, dependency-free. */
function fnv1a(text: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

/**
 * Deterministic MinHash permutation parameters (a odd & non-zero, b any), built
 * from a fixed-seed LCG so signatures are reproducible run-to-run.
 */
function buildPermutations(): { a: number[]; b: number[] } {
  const a: number[] = [];
  const b: number[] = [];
  let state = 0x9e_37_79_b9; // golden-ratio seed.
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  for (let i = 0; i < NUM_PERM; i += 1) {
    a.push((next() | 1) >>> 0); // force odd so the multiplier is a bijection mod 2^32.
    b.push(next() >>> 0);
  }
  return { a, b };
}

const PERM = buildPermutations();

/**
 * Word 5-gram shingle set, lowercased and whitespace-collapsed for DETECTION
 * only. Texts shorter than k words fall back to a single whole-text shingle so
 * short messages can still match exactly. Empty text yields the empty set.
 */
function shingles(text: string): Set<string> {
  const tokens = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  if (tokens.length === 0) {
    return set;
  }
  if (tokens.length < SHINGLE_K) {
    set.add(tokens.join(" "));
    return set;
  }
  for (let i = 0; i + SHINGLE_K <= tokens.length; i += 1) {
    set.add(tokens.slice(i, i + SHINGLE_K).join(" "));
  }
  return set;
}

/** Exact Jaccard similarity of two shingle sets; 0 when their union is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const shingle of small) {
    if (large.has(shingle)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** MinHash signature: per permutation, the min hash over the item's shingles. */
function signature(shingleSet: Set<string>): number[] {
  const sig = new Array<number>(NUM_PERM).fill(UINT32);
  for (const shingle of shingleSet) {
    const base = fnv1a(shingle);
    for (let i = 0; i < NUM_PERM; i += 1) {
      const a = PERM.a[i] ?? 1;
      const b = PERM.b[i] ?? 0;
      const hashed = (Math.imul(a, base) + b) >>> 0;
      if (hashed < (sig[i] ?? UINT32)) {
        sig[i] = hashed;
      }
    }
  }
  return sig;
}

/** Per-band bucket keys for LSH: a fold of each band's rows, tagged by band index. */
function bandKeys(sig: number[]): string[] {
  const keys: string[] = [];
  for (let band = 0; band < LSH_BANDS; band += 1) {
    let fold = 0x81_1c_9d_c5;
    for (let row = 0; row < LSH_ROWS; row += 1) {
      fold = (Math.imul(fold ^ (sig[band * LSH_ROWS + row] ?? 0), 0x01_00_01_93) >>> 0) >>> 0;
    }
    keys.push(`${band}:${fold}`);
  }
  return keys;
}

/** Union-find with path compression; cluster membership only (root identity is arbitrary). */
class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) ?? root;
    }
    let cursor = id;
    while (cursor !== root) {
      const nextCursor = this.parent.get(cursor) ?? root;
      this.parent.set(cursor, root);
      cursor = nextCursor;
    }
    return root;
  }

  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) {
      this.parent.set(rx, ry);
    }
  }
}

/** True when `a` is the better canonical: earlier timestamp, ties broken by smaller id. */
function isEarlier(a: DedupItem, b: DedupItem): boolean {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp < b.timestamp;
  }
  return a.id < b.id;
}

/**
 * LSH blocking: bucket item ids by shared band keys (a collision in any band
 * makes two items candidate near-duplicates worth an exact check).
 */
function buildBuckets(
  items: DedupItem[],
  shingleSets: Map<string, Set<string>>,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const item of items) {
    const sig = signature(shingleSets.get(item.id) ?? new Set());
    for (const key of bandKeys(sig)) {
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, [item.id]);
      } else {
        bucket.push(item.id);
      }
    }
  }
  return buckets;
}

/**
 * Confirm one candidate pair with exact Jaccard (once), unioning it when at/above
 * the threshold. `confirmed` dedupes the same pair surfacing from multiple bands.
 */
function confirmPair(
  x: string,
  y: string,
  shingleSets: Map<string, Set<string>>,
  threshold: number,
  confirmed: Set<string>,
  uf: UnionFind,
): void {
  const pairKey = x < y ? `${x} ${y}` : `${y} ${x}`;
  if (confirmed.has(pairKey)) {
    return;
  }
  confirmed.add(pairKey);
  const sim = jaccard(shingleSets.get(x) ?? new Set(), shingleSets.get(y) ?? new Set());
  if (sim >= threshold) {
    uf.union(x, y);
  }
}

/** Confirm every candidate pair within a bucket. */
function unionBucket(
  bucket: string[],
  shingleSets: Map<string, Set<string>>,
  threshold: number,
  confirmed: Set<string>,
  uf: UnionFind,
): void {
  for (let i = 0; i < bucket.length; i += 1) {
    for (let j = i + 1; j < bucket.length; j += 1) {
      confirmPair(bucket[i] ?? "", bucket[j] ?? "", shingleSets, threshold, confirmed, uf);
    }
  }
}

/** Stamp each item with its cluster id + canonical flag (keep-earliest per cluster). */
function assignClusters(items: DedupItem[], uf: UnionFind): Map<string, DedupResult> {
  const canonicalByRoot = new Map<string, DedupItem>();
  for (const item of items) {
    const root = uf.find(item.id);
    const current = canonicalByRoot.get(root);
    if (current === undefined || isEarlier(item, current)) {
      canonicalByRoot.set(root, item);
    }
  }
  const result = new Map<string, DedupResult>();
  for (const item of items) {
    const canonical = canonicalByRoot.get(uf.find(item.id)) ?? item;
    result.set(item.id, {
      dedup_cluster_id: canonical.id,
      is_canonical: item.id === canonical.id,
    });
  }
  return result;
}

/**
 * Cluster near-duplicate items and assign each a `dedup_cluster_id` +
 * `is_canonical` (keep-earliest). Pure and deterministic.
 */
export function dedup(items: DedupItem[], options: DedupOptions = {}): Map<string, DedupResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const shingleSets = new Map<string, Set<string>>();
  const uf = new UnionFind();
  for (const item of items) {
    uf.add(item.id);
    shingleSets.set(item.id, shingles(item.text));
  }

  // LSH blocking → exact-Jaccard confirmation → keep-earliest cluster assignment.
  const buckets = buildBuckets(items, shingleSets);
  const confirmed = new Set<string>();
  for (const bucket of buckets.values()) {
    unionBucket(bucket, shingleSets, threshold, confirmed, uf);
  }

  return assignClusters(items, uf);
}
