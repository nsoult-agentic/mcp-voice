import { describe, expect, test } from "bun:test";

import { stripMatrixBoundaries } from "../src/boundary.ts";

// Matrix boundary stripping (spec §5 step 3, §8). Matrix rich-reply fallback
// puts the QUOTED text FIRST — a run of "> …" lines (the first carries the
// "<@mxid>" attribution), then a blank line, then the operator's actual reply.
// So unlike email (keep-lead, drop-from-first-boundary), the Matrix rule is:
// drop the LEADING quote-fallback block, keep everything after, byte-identical.

describe("stripMatrixBoundaries — leading reply-fallback removal (§8)", () => {
  test("a message with no quote is returned unchanged", () => {
    const body = "yeah let's ship it after lunch 🚀";
    expect(stripMatrixBoundaries(body)).toBe(body);
  });

  test("a single-line reply fallback is stripped, leaving the reply", () => {
    const body = "> <@alice:server.org> what time works for the call?\n\nafter 3pm is good for me";
    expect(stripMatrixBoundaries(body)).toBe("after 3pm is good for me");
  });

  test("a multi-line reply fallback is stripped entirely", () => {
    const body =
      "> <@alice:server.org> can you review this today\n> and also check the migration\n\nyep, on it now — will ping you when done";
    expect(stripMatrixBoundaries(body)).toBe("yep, on it now — will ping you when done");
  });

  test("the kept reply preserves case, punctuation, em-dash and emoji byte-for-byte", () => {
    const reply = "Honestly? NO — that timeline's wild 😅 let's talk Monday";
    const body = `> <@bob:server.org> can we do it by Friday?\n\n${reply}`;
    expect(stripMatrixBoundaries(body)).toBe(reply);
  });

  test("a multi-line reply body keeps all of its own lines", () => {
    const body = "> <@alice:server.org> thoughts?\n\nfirst point here\nsecond point here";
    expect(stripMatrixBoundaries(body)).toBe("first point here\nsecond point here");
  });

  test("a message that is only a quote with no reply yields empty", () => {
    const body = "> <@alice:server.org> just this, nothing from me";
    expect(stripMatrixBoundaries(body)).toBe("");
  });
});
