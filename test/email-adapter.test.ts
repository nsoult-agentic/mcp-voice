import { describe, expect, test } from "bun:test";

import { createEmailAdapter } from "../src/adapters/email.ts";

// Email adapter (spec §6). A pull()-style interface over an INJECTABLE mail
// source (no live IMAP). Own-authorship predicate: keep only mail where
// From ∈ operator addresses AND from the Sent folder; drop third-party mail.

const OPERATOR_CONFIG = {
  author_id: "operator",
  addresses: ["nico@example.com", "nico@soult.io"],
};

// An in-memory mail source standing in for mcp-email / the Sent store.
// Each message declares which folder it lives in and its From address.
function makeSource(messages: Array<Record<string, unknown>>) {
  return {
    async fetch() {
      return messages;
    },
  };
}

const operatorSent = {
  message_id: "<m1@host>",
  folder: "Sent",
  from: "nico@example.com",
  date: "2026-06-01T09:00:00.000Z",
  thread_id: "t1",
  body: "Yeah, I'll have them over to you tonight — promise! 🙂",
};

const thirdPartyInbox = {
  message_id: "<m2@host>",
  folder: "INBOX",
  from: "someone@elsewhere.com",
  date: "2026-06-01T08:00:00.000Z",
  thread_id: "t1",
  body: "Can you get me the Q3 numbers before the board call?",
};

const operatorButInbox = {
  // Operator address but NOT in the Sent folder (e.g. a message TO self in inbox).
  message_id: "<m3@host>",
  folder: "INBOX",
  from: "nico@example.com",
  date: "2026-06-01T07:00:00.000Z",
  thread_id: "t2",
  body: "Note to self.",
};

describe("createEmailAdapter — own-authorship filtering (§6)", () => {
  test("pull() returns only operator-authored, Sent-folder messages", async () => {
    const adapter = createEmailAdapter({
      source: makeSource([operatorSent, thirdPartyInbox, operatorButInbox]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(1);
    expect(units[0]?.source_uri).toContain("<m1@host>");
  });

  test("third-party messages are dropped entirely (not carried through)", async () => {
    const adapter = createEmailAdapter({
      source: makeSource([operatorSent, thirdPartyInbox]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    const allText = units.map((u) => u.raw_text).join("\n");
    expect(allText).not.toContain("Q3 numbers");
    expect(allText).not.toContain("board call");
    expect(units.every((u) => OPERATOR_CONFIG.addresses.includes(u.author_address ?? ""))).toBe(
      true,
    );
  });

  test("operator address outside the Sent folder is dropped (Sent-only rule)", async () => {
    const adapter = createEmailAdapter({
      source: makeSource([operatorButInbox]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(0);
  });

  test("a mixed batch yields only operator-authored records", async () => {
    const adapter = createEmailAdapter({
      source: makeSource([
        thirdPartyInbox,
        operatorSent,
        operatorButInbox,
        { ...thirdPartyInbox, message_id: "<m4@host>", from: "boss@corp.com" },
      ]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(1);
    expect(units[0]?.author_address).toBe("nico@example.com");
  });
});

describe("createEmailAdapter — robust own-address match (§6 guardrail)", () => {
  test("From with a display name + different case still matches the operator", async () => {
    const headerCased = {
      message_id: "<m5@host>",
      folder: "Sent",
      // Display name + bracketed address, with the local part upper-cased.
      from: '"Nico" <Nico@Example.com>',
      date: "2026-06-01T10:00:00.000Z",
      thread_id: "t3",
      body: "Shipping it now.",
    };
    const adapter = createEmailAdapter({
      source: makeSource([headerCased]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(1);
    expect(units[0]?.source_uri).toContain("<m5@host>");
  });

  test("a genuinely different address is still dropped", async () => {
    const otherSent = {
      message_id: "<m6@host>",
      folder: "Sent",
      from: '"Someone" <someone@elsewhere.com>',
      date: "2026-06-01T10:00:00.000Z",
      thread_id: "t4",
      body: "Not the operator.",
    };
    const adapter = createEmailAdapter({
      source: makeSource([otherSent]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(0);
  });
});

describe("createEmailAdapter — RawUnit shape (medium + provenance, §5 step 1)", () => {
  test("each unit is tagged medium=email with provenance and timestamp", async () => {
    const adapter = createEmailAdapter({
      source: makeSource([operatorSent]),
      operator: OPERATOR_CONFIG,
    });
    const units = await adapter.pull();
    const u = units[0];
    expect(u?.medium).toBe("email");
    expect(u?.author_id).toBe("operator");
    expect(u?.source_uri).toContain("<m1@host>");
    expect(u?.timestamp).toBe("2026-06-01T09:00:00.000Z");
    expect(u?.thread_id).toBe("t1");
    // Adapter carries the as-pulled body; boundary stripping happens later.
    expect(u?.raw_text).toContain("Yeah, I'll have them over to you tonight");
  });
});
