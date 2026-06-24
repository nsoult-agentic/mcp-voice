import { describe, expect, test } from "bun:test";

import { CorpusRecordSchema } from "../src/corpus-record.ts";
import { runPipeline } from "../src/pipeline.ts";

// Pipeline (spec §5): adapter → own-authorship filter → boundary strip
// → code/prose split → dedup → register classification → accounting → emit.
// Slice 2 makes dedup (MinHash/LSH, keep-earliest), register classification, and
// the matrix medium real. The whole pipeline stays pure and idempotent.

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
      "Yeah, I'll have them over to you tonight — I'm on it! \u{1F642}",
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

// A matrix RawUnit as produced by the matrix adapter (medium "matrix").
function matrixUnit(overrides: Record<string, unknown> = {}) {
  return {
    author_id: "operator",
    medium: "matrix" as const,
    source_uri: "matrix-event:$ev1",
    thread_id: null,
    timestamp: "2026-06-01T09:00:00.000Z",
    raw_text: "yeah let's ship it after lunch 🚀",
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
    expect(r?.text_clean).toBe("Yeah, I'll have them over to you tonight — I'm on it! \u{1F642}");
    expect(r?.text_clean).not.toContain("Q3 numbers");
    expect(r?.text_clean).not.toContain("John");
    expect(r?.text_clean).not.toContain("sent from my phone");
  });

  test("text_clean preserves voice tokens byte-identical (PRESERVE, §8)", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.text_clean).toContain("—");
    expect(r?.text_clean).toContain("\u{1F642}");
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

describe("runPipeline — distinct units stay separate singletons (§8)", () => {
  test("non-duplicate records each form their own canonical cluster", () => {
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

describe("runPipeline — near-duplicate dedup, keep-earliest (§5, §8)", () => {
  test("two near-identical units collapse to one canonical (earliest) record", () => {
    const body =
      "Thanks so much for sorting this out, I really appreciate the quick turnaround on it!";
    const records = runPipeline(
      [
        rawUnit({
          source_uri: "message-id:<late@host>",
          timestamp: "2026-06-02T10:00:00.000Z",
          raw_text: body.toUpperCase(),
        }),
        rawUnit({
          source_uri: "message-id:<early@host>",
          timestamp: "2026-06-01T09:00:00.000Z",
          raw_text: body,
        }),
      ],
      { ingest_version: INGEST_VERSION },
    );
    const early = records.find((r) => r.source_uri.includes("<early@host>"));
    const late = records.find((r) => r.source_uri.includes("<late@host>"));
    // Both records are still emitted (cluster membership is recorded, not dropped).
    expect(records).toHaveLength(2);
    expect(early?.is_canonical).toBe(true);
    expect(late?.is_canonical).toBe(false);
    // The non-canonical points at the canonical's cluster.
    expect(late?.dedup_cluster_id).toBe(early?.id);
    expect(early?.dedup_cluster_id).toBe(early?.id);
  });
});

describe("runPipeline — matrix medium end-to-end (§3, §6)", () => {
  test("a matrix unit emits a schema-valid record with medium matrix", () => {
    const [r] = runPipeline([matrixUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.medium).toBe("matrix");
    expect(() => CorpusRecordSchema.parse(r)).not.toThrow();
  });

  test("matrix reply-fallback boundaries are stripped inside the pipeline", () => {
    const raw = "> <@alice:server.org> what time works?\n\nafter 3pm is good for me";
    const [r] = runPipeline([matrixUnit({ raw_text: raw })], { ingest_version: INGEST_VERSION });
    expect(r?.text_clean).toBe("after 3pm is good for me");
    expect(r?.text_clean).not.toContain("alice");
  });
});

describe("runPipeline — register classification (§3, §8)", () => {
  test("a matrix unit defaults to the chat register", () => {
    const [r] = runPipeline([matrixUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.register).toBe("chat");
  });

  test("an ordinary email unit defaults to the email register", () => {
    const [r] = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(r?.register).toBe("email");
  });

  test("a terse one-line email is classified as chat", () => {
    const [r] = runPipeline([rawUnit({ raw_text: "sounds good, see you then" })], {
      ingest_version: INGEST_VERSION,
    });
    expect(r?.register).toBe("chat");
  });

  test("a long structured matrix message is classified as longform", () => {
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `sentence number ${i} carrying some actual substance about the topic`,
    ).join(" ");
    const [r] = runPipeline([matrixUnit({ raw_text: longBody })], {
      ingest_version: INGEST_VERSION,
    });
    expect(r?.register).toBe("longform");
  });
});

describe("runPipeline — code/prose split + empty-prose drop (§5 step 4)", () => {
  test("a fenced code block is stripped from text_clean inside the pipeline", () => {
    const raw = "here's the patch:\n\n```ts\nconst x = 1;\n```\n\nshould do it";
    const [r] = runPipeline([matrixUnit({ raw_text: raw })], { ingest_version: INGEST_VERSION });
    expect(r?.text_clean).toBe("here's the patch:\n\nshould do it");
    expect(r?.text_clean).not.toContain("const x");
  });

  test("a unit that is all code (empty prose) is dropped, not emitted", () => {
    const records = runPipeline(
      [
        matrixUnit({ source_uri: "matrix-event:$code", raw_text: "```\nrm -rf /tmp/x\n```" }),
        matrixUnit({ source_uri: "matrix-event:$prose", raw_text: "real words here please" }),
      ],
      { ingest_version: INGEST_VERSION },
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.source_uri).toBe("matrix-event:$prose");
  });

  test("a matrix unit that is only a quoted reply (empty after strip) is dropped", () => {
    const records = runPipeline(
      [matrixUnit({ raw_text: "> <@alice:server.org> nothing from me to add" })],
      { ingest_version: INGEST_VERSION },
    );
    expect(records).toHaveLength(0);
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

describe("runPipeline — NORMALIZE-only applied to text_clean (§8)", () => {
  test("end-to-end: NFC-precomposes and strips control chars, voice tokens survive", () => {
    // Build the operator text from explicit code points so the test is exact:
    //   - decomposed "é" = "e" + U+0301 COMBINING ACUTE ACCENT
    //   - a stray control char U+0007 (BEL)
    //   - voice tokens: em-dash (U+2014), emoji (U+1F642), and a contraction.
    const combiningAcute = "́";
    const controlChar = "";
    const raw = `Cafe${combiningAcute} — I'll${controlChar} send it \u{1F642}`;
    const [r] = runPipeline([rawUnit({ raw_text: raw })], { ingest_version: INGEST_VERSION });
    const clean = r?.text_clean ?? "";
    // NFC: precomposed "é" (U+00E9) present; the standalone combining mark is gone.
    expect(clean).toContain("é");
    expect(clean).not.toContain(combiningAcute);
    // Control char removed.
    expect(clean).not.toContain(controlChar);
    // PRESERVE: em-dash, emoji, contraction byte-identical.
    expect(clean).toContain("—");
    expect(clean).toContain("\u{1F642}");
    expect(clean).toContain("I'll");
    expect(clean).toBe("Café — I'll send it \u{1F642}");
  });
});

describe("runPipeline — schema validation at emit (fail-fast)", () => {
  test("valid units pass through unchanged (schema-valid record)", () => {
    const records = runPipeline([rawUnit()], { ingest_version: INGEST_VERSION });
    expect(records).toHaveLength(1);
    expect(() => CorpusRecordSchema.parse(records[0])).not.toThrow();
  });

  test("a unit yielding an invalid record throws naming the source_uri", () => {
    // A non-ISO/empty timestamp produces a schema-invalid record. Construct the
    // bad unit at the RawUnit boundary; runPipeline must fail-fast, not drop it.
    const bad = rawUnit({ source_uri: "message-id:<bad@host>", timestamp: "not-a-timestamp" });
    expect(() => runPipeline([bad], { ingest_version: INGEST_VERSION })).toThrow(
      /message-id:<bad@host>/,
    );
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
