import { describe, expect, test } from "bun:test";

import { createMatrixAdapter } from "../src/adapters/matrix.ts";

// Matrix source adapter (spec §6, §5 step 1). pull() returns only the operator's
// own authored m.text messages as RawUnits, tagged medium:"matrix" + provenance.
// The source is INJECTED (no live Matrix sync), so the own-authorship predicate
// (sender == operator MXID) is unit-testable in isolation. Third-party messages,
// non-text events (images, files, notices) and system events (memberships) are
// dropped here, before any processing — the "authorized voices only" guardrail.

const OPERATOR = {
  author_id: "operator",
  mxids: ["@nico:soult.io"],
};

function makeSource(events: Array<Record<string, unknown>>) {
  return {
    async fetch() {
      return events;
    },
  };
}

const operatorText = {
  event_id: "$ev1",
  type: "m.room.message",
  sender: "@nico:soult.io",
  origin_server_ts: 1_717_235_400_000,
  content: { msgtype: "m.text", body: "yeah let's ship it after lunch 🚀" },
};

const thirdPartyText = {
  event_id: "$ev2",
  type: "m.room.message",
  sender: "@someoneelse:server.org",
  origin_server_ts: 1_717_235_300_000,
  content: { msgtype: "m.text", body: "can you take a look at the PR?" },
};

const operatorImage = {
  event_id: "$ev3",
  type: "m.room.message",
  sender: "@nico:soult.io",
  origin_server_ts: 1_717_235_500_000,
  content: { msgtype: "m.image", body: "screenshot.png", url: "mxc://x/y" },
};

const systemEvent = {
  event_id: "$ev4",
  type: "m.room.member",
  sender: "@nico:soult.io",
  origin_server_ts: 1_717_235_600_000,
  content: { membership: "join" },
};

describe("createMatrixAdapter — own-authorship filtering (§6)", () => {
  test("pull() returns only operator-authored m.text messages", async () => {
    const adapter = createMatrixAdapter({
      source: makeSource([operatorText, thirdPartyText, operatorImage, systemEvent]),
      operator: OPERATOR,
    });
    const units = await adapter.pull();
    expect(units).toHaveLength(1);
    const unit = units[0];
    expect(unit?.medium).toBe("matrix");
    expect(unit?.author_id).toBe("operator");
    expect(unit?.raw_text).toBe("yeah let's ship it after lunch 🚀");
  });

  test("source_uri carries the matrix event id as provenance", async () => {
    const adapter = createMatrixAdapter({ source: makeSource([operatorText]), operator: OPERATOR });
    const [unit] = await adapter.pull();
    expect(unit?.source_uri).toBe("matrix-event:$ev1");
  });

  test("origin_server_ts (epoch ms) is converted to an ISO-8601 timestamp", async () => {
    const adapter = createMatrixAdapter({ source: makeSource([operatorText]), operator: OPERATOR });
    const [unit] = await adapter.pull();
    expect(unit?.timestamp).toBe(new Date(1_717_235_400_000).toISOString());
  });

  test("thread relation populates thread_id; its absence yields null", async () => {
    const threaded = {
      ...operatorText,
      event_id: "$ev5",
      content: {
        msgtype: "m.text",
        body: "replying in the thread",
        "m.relates_to": { rel_type: "m.thread", event_id: "$root1" },
      },
    };
    const adapter = createMatrixAdapter({
      source: makeSource([operatorText, threaded]),
      operator: OPERATOR,
    });
    const units = await adapter.pull();
    const plain = units.find((u) => u.source_uri === "matrix-event:$ev1");
    const inThread = units.find((u) => u.source_uri === "matrix-event:$ev5");
    expect(plain?.thread_id).toBeNull();
    expect(inThread?.thread_id).toBe("$root1");
  });

  test("a non-reply edit relation does not become a thread_id", async () => {
    // m.replace (message edit) is NOT a thread; thread_id stays null.
    const edited = {
      ...operatorText,
      event_id: "$ev6",
      content: {
        msgtype: "m.text",
        body: "the corrected text",
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      },
    };
    const adapter = createMatrixAdapter({ source: makeSource([edited]), operator: OPERATOR });
    const [unit] = await adapter.pull();
    expect(unit?.thread_id).toBeNull();
  });
});
