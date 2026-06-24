import { describe, expect, test } from "bun:test";

import { computeId, CorpusRecordSchema, MEDIUM_REGISTER_DEFAULT } from "../src/corpus-record.ts";

// Expected values are derived from spec §4 (the CorpusRecord contract), §3
// (medium/register enums + default map) and §11 (D1/D6). Nothing here mirrors
// an implementation — the modules under src/ do not exist yet (fail-first).

// A fully-valid slice-1 record. medium is restricted to "email" in slice 1,
// register is one of {chat, email, longform}.
function validRecord() {
  return {
    id: "deadbeef",
    author_id: "operator",
    medium: "email" as const,
    register: "email" as const,
    source_uri: "message-id:<abc@host>",
    thread_id: null,
    timestamp: "2026-06-01T12:00:00.000Z",
    text_clean: "Yeah, I'll have them over to you tonight — promise! 🙂",
    word_count: 9,
    dedup_cluster_id: "deadbeef",
    is_canonical: true,
    ingest_version: "ingestion-slice-1",
  };
}

describe("CorpusRecordSchema — valid records", () => {
  test("a well-formed record passes", () => {
    const r = CorpusRecordSchema.parse(validRecord());
    expect(r.id).toBe("deadbeef");
    expect(r.medium).toBe("email");
    expect(r.register).toBe("email");
  });

  test("thread_id may be a string or null", () => {
    expect(() =>
      CorpusRecordSchema.parse({ ...validRecord(), thread_id: "thread-7" }),
    ).not.toThrow();
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), thread_id: null })).not.toThrow();
  });

  test("all three registers are accepted", () => {
    for (const register of ["chat", "email", "longform"] as const) {
      expect(() => CorpusRecordSchema.parse({ ...validRecord(), register })).not.toThrow();
    }
  });

  test("both v1 mediums are accepted", () => {
    for (const medium of ["email", "matrix"] as const) {
      expect(() => CorpusRecordSchema.parse({ ...validRecord(), medium })).not.toThrow();
    }
  });
});

describe("CorpusRecordSchema — invalid records fail", () => {
  test("a medium outside the v1 scope is rejected", () => {
    // doc/commit/pr are deferred post-v1; sms is not a medium at all.
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), medium: "doc" })).toThrow();
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), medium: "sms" })).toThrow();
  });

  test("bad register enum is rejected", () => {
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), register: "technical" })).toThrow();
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), register: "notes" })).toThrow();
  });

  test("a missing required field is rejected", () => {
    const { text_clean, ...withoutText } = validRecord();
    void text_clean;
    expect(() => CorpusRecordSchema.parse(withoutText)).toThrow();
  });

  test("a non-ISO-8601 timestamp is rejected", () => {
    expect(() =>
      CorpusRecordSchema.parse({ ...validRecord(), timestamp: "2026-06-01 12:00:00" }),
    ).toThrow();
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), timestamp: "not-a-date" })).toThrow();
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), timestamp: "06/01/2026" })).toThrow();
  });

  test("wrong type for word_count is rejected", () => {
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), word_count: "9" })).toThrow();
  });

  test("wrong type for is_canonical is rejected", () => {
    expect(() => CorpusRecordSchema.parse({ ...validRecord(), is_canonical: "true" })).toThrow();
  });
});

describe("CorpusRecord shape — D6 (text_clean only, no raw/redacted fields)", () => {
  test("record carries text_clean", () => {
    const r = CorpusRecordSchema.parse(validRecord());
    expect(r).toHaveProperty("text_clean");
  });

  test("schema strips/rejects a raw original blob and a redaction field", () => {
    // D6: the untouched raw blob is NOT stored. D5: no PII redaction in v1.
    const parsed = CorpusRecordSchema.parse({
      ...validRecord(),
      text_raw: "RAW ORIGINAL WITH QUOTES",
      text_redacted: "redacted [PII]",
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("text_raw");
    expect(parsed).not.toHaveProperty("text_redacted");
    expect(parsed).not.toHaveProperty("raw");
  });
});

describe("computeId — stable content hash (idempotency, §5 / §10.3)", () => {
  const base = {
    author_id: "operator",
    medium: "email" as const,
    source_uri: "message-id:<abc@host>",
    content: "Yeah, I'll have them over to you tonight.",
  };

  test("same input content yields the same id", () => {
    const a = computeId(base);
    const b = computeId({ ...base });
    expect(a).toBe(b);
  });

  test("id is a non-empty string", () => {
    expect(typeof computeId(base)).toBe("string");
    expect(computeId(base).length).toBeGreaterThan(0);
  });

  test("different content yields a different id", () => {
    const a = computeId(base);
    const b = computeId({ ...base, content: "Different words entirely." });
    expect(a).not.toBe(b);
  });

  test("different provenance (source_uri) yields a different id", () => {
    const a = computeId(base);
    const b = computeId({ ...base, source_uri: "message-id:<zzz@host>" });
    expect(a).not.toBe(b);
  });
});

describe("MEDIUM_REGISTER_DEFAULT map (§3)", () => {
  test("email defaults to the email register", () => {
    expect(MEDIUM_REGISTER_DEFAULT.email).toBe("email");
  });
});
