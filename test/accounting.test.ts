import { describe, expect, test } from "bun:test";

import { accountVolume } from "../src/accounting.ts";
import type { CorpusRecord } from "../src/corpus-record.ts";

// Volume accounting & readiness tiers (spec §9). Per (author_id, register), tally
// CANONICAL word counts + sample counts and surface a readiness tier consumed by
// voice-model. Only is_canonical records count (§8). Tiers (literature estimates,
// tunable): insufficient < ~1k words; generation-ready ≥ ~1k; profile-grade ≥
// ~100k words OR ≥ ~100 samples.

function record(over: Partial<CorpusRecord>): CorpusRecord {
  return {
    id: "id",
    author_id: "operator",
    medium: "email",
    register: "email",
    source_uri: "message-id:<m@host>",
    thread_id: null,
    timestamp: "2026-06-01T00:00:00.000Z",
    text_clean: "x",
    word_count: 1,
    dedup_cluster_id: "id",
    is_canonical: true,
    ingest_version: "v",
    ...over,
  };
}

// Build n canonical records in one (author_id, register) group with given words each.
function group(
  author_id: string,
  register: CorpusRecord["register"],
  count: number,
  wordsEach: number,
): CorpusRecord[] {
  return Array.from({ length: count }, (_, i) =>
    record({ id: `${author_id}-${register}-${i}`, author_id, register, word_count: wordsEach }),
  );
}

describe("accountVolume — grouping & canonical-only counts (§9)", () => {
  test("groups by (author_id, register) and sums canonical word counts", () => {
    const stats = accountVolume([
      record({ id: "a", register: "email", word_count: 10 }),
      record({ id: "b", register: "email", word_count: 5 }),
      record({ id: "c", register: "chat", word_count: 3 }),
    ]);
    const email = stats.find((s) => s.register === "email");
    const chat = stats.find((s) => s.register === "chat");
    expect(email?.word_count).toBe(15);
    expect(email?.sample_count).toBe(2);
    expect(chat?.word_count).toBe(3);
    expect(chat?.sample_count).toBe(1);
  });

  test("non-canonical records are excluded from counts", () => {
    const stats = accountVolume([
      record({ id: "a", word_count: 10, is_canonical: true }),
      record({ id: "b", word_count: 99, is_canonical: false }),
    ]);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.word_count).toBe(10);
    expect(stats[0]?.sample_count).toBe(1);
  });

  test("separate authors are tallied separately", () => {
    const stats = accountVolume([
      record({ id: "a", author_id: "operator", word_count: 4 }),
      record({ id: "b", author_id: "alt-voice", word_count: 7 }),
    ]);
    expect(stats.find((s) => s.author_id === "operator")?.word_count).toBe(4);
    expect(stats.find((s) => s.author_id === "alt-voice")?.word_count).toBe(7);
  });

  test("output is deterministically ordered by author_id then register", () => {
    const stats = accountVolume([
      record({ id: "a", author_id: "operator", register: "longform", word_count: 1 }),
      record({ id: "b", author_id: "alt", register: "email", word_count: 1 }),
      record({ id: "c", author_id: "operator", register: "chat", word_count: 1 }),
    ]);
    expect(stats.map((s) => `${s.author_id}/${s.register}`)).toEqual([
      "alt/email",
      "operator/chat",
      "operator/longform",
    ]);
  });
});

describe("accountVolume — readiness tiers (§9)", () => {
  test("under ~1k canonical words is insufficient", () => {
    const stats = accountVolume(group("operator", "email", 5, 100)); // 500 words
    expect(stats[0]?.tier).toBe("insufficient");
  });

  test("at/above ~1k words is generation-ready", () => {
    const stats = accountVolume(group("operator", "email", 10, 100)); // 1000 words
    expect(stats[0]?.tier).toBe("generation-ready");
  });

  test("at/above ~100k words is profile-grade", () => {
    const stats = accountVolume(group("operator", "email", 100, 1000)); // 100k words
    expect(stats[0]?.tier).toBe("profile-grade");
  });

  test("at/above ~100 samples is profile-grade even when words are modest", () => {
    const stats = accountVolume(group("operator", "chat", 100, 5)); // 100 samples, 500 words
    expect(stats[0]?.sample_count).toBe(100);
    expect(stats[0]?.tier).toBe("profile-grade");
  });

  test("an empty corpus yields no stats", () => {
    expect(accountVolume([])).toEqual([]);
  });
});
