import { describe, expect, test } from "bun:test";

import { CorpusRecordSchema } from "../src/corpus-record.ts";
import { runPipeline } from "../src/pipeline.ts";

// Pipeline skeleton (spec §5): adapter → own-authorship filter → boundary strip
// → code/prose split → dedup → register classification → accounting → emit.
// Slice 1: dedup is a pass-through (cluster_id = id, is_canonical = true), and
// register defaults via the medium→register map. Whole pipeline is idempotent.

// A RawUnit as produced by an adapter (post own-authorship filter). The pipeline
// takes these and emits CorpusRecords.
function rawUnit(overrides: Record<string, unknown> = {}) {
  return {
    author_id: "operator",
    medium: "email" as const,
    source_uri: "message-id:<m1@host>",
    thread_id: "t1",
    timestamp: "2026-06-01T09:00:00.000Z",
    raw_text: [
      "Yeah, I'll have them over to you tonight — I'm on it! 🙂",
      "",
      "On Tuesday, John wrote:",
      "> Can you get me the Q3 numbers before the board call?",
      "",
      "-- ",
      "Nico · sent from my phone",
    ].join("\n"),
    ...overrides,
  };
}

const INGEST_VERSION = "ingestion-slice-1";

describe("runPipeline — emits valid CorpusRecords (§4, §5)", () => {
  test("a unit flows through to a schema-valid record", () => {
    const records = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(records).toHaveLength(1);
    expect(() => CorpusRecordSchema.parse(records[0])).not.toThrow();
  });

  test("boundary stripping runs inside the pipeline (third-party words gone)", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.text_clean).toBe("Yeah, I'll have them over to you tonight — I'm on it! 🙂");
    expect(r?.text_clean).not.toContain("Q3 numbers");
    expect(r?.text_clean).not.toContain("John");
    expect(r?.text_clean).not.toContain("sent from my phone");
  });

  test("text_clean preserves voice tokens byte-identical (PRESERVE, §8)", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.text_clean).toContain("—");
    expect(r?.text_clean).toContain("🙂");
    expect(r?.text_clean).toContain("I'll");
  });

  test("word_count is counted on text_clean", () => {
    const [r] = runPipeline([rawUnit({ raw_text: "one two three four" })], {
      ingest_version: INGEST_VERSION,
    });
    expect(r?.text_clean).toBe("one two three four");
    expect(r?.word_count).toBe(4);
  });
});

describe("runPipeline — dedup pass-through (slice 1)", () => {
  test("each record's dedup_cluster_id equals its own id, is_canonical true", () => {
    const records = runPipeline(
      [rawUnit(), rawUnit({ source_uri: "message-id:<m2@host>", raw_text: "Totally different." })],
      { ingest_version: INGEST_VERSION },
    );
    for (const r of records) {
      expect(r.dedup_cluster_id).toBe(r.id);
      expect(r.is_canonical).toBe(true);
    }
  });
});

describe("runPipeline — register default via medium→register map (§3)", () => {
  test("an email-medium unit defaults to the email register", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.register).toBe("email");
  });
});

describe("runPipeline — idempotency (§5, §10.3)", () => {
  test("running twice over the same input yields identical ids", () => {
    const first = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    const second = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  test("re-running over a unit already seen produces no duplicate records", () => {
    // Two identical units in one batch must collapse to a single id; the output
    // must not contain two records with the same id.
    const records = runPipeline([rawUnit(), rawUnit()], { ingest_version: INGEST_VERSION });
    const ids = records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("id is stable across runs and tied to content, not call order", () => {
    const a = runPipeline([rawUnit({ source_uri: "message-id:<x@host>" })], {
      ingest_version: INGEST_VERSION,
    });
    const b = runPipeline(
      [
        rawUnit({ source_uri: "message-id:<y@host>", raw_text: "Other content." }),
        rawUnit({ source_uri: "message-id:<x@host>" }),
      ],
      { ingest_version: INGEST_VERSION },
    );
    const xFromA = a.find((r) => r.source_uri.includes("<x@host>"));
    const xFromB = b.find((r) => r.source_uri.includes("<x@host>"));
    expect(xFromB?.id).toBe(xFromA?.id);
  });
});

describe("runPipeline — record carries no raw/redacted fields (D5/D6)", () => {
  test("emitted record has text_clean and not a raw or redacted field", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION }) as Array<
      Record<string, unknown>
    >;
    expect(r).toHaveProperty("text_clean");
    expect(r).not.toHaveProperty("text_raw");
    expect(r).not.toHaveProperty("raw_text");
    expect(r).not.toHaveProperty("text_redacted");
  });
});
