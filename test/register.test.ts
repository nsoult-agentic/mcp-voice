import { describe, expect, test } from "bun:test";

import { classifyRegister } from "../src/register.ts";

// Register classification (spec §5 step 6, §8). Start from the medium→register
// default; a lightweight content signal may override (a long structured message
// → `longform`, a terse one-liner → `chat`). Cross-register transfer is risky
// (55pp penalty), so on a weak signal KEEP THE MEDIUM DEFAULT rather than guess.

const SHORT_EMAIL = "sounds good, see you then";
const TERSE_CHAT = "lol yeah";

// A long, multi-paragraph structured body — the clear `longform` signal,
// independent of medium.
const LONGFORM_BODY = Array.from(
  { length: 60 },
  (_, i) => `sentence number ${i} carrying some actual substance about the topic`,
).join(" ");

describe("classifyRegister — defaults & overrides (§8)", () => {
  test("email of ordinary length keeps the email default", () => {
    const body =
      "Hi Sam, attaching the revised figures — let me know if the totals line up. Cheers, Nico";
    expect(classifyRegister({ medium: "email", text: body, word_count: 17 })).toBe("email");
  });

  test("matrix message of ordinary length keeps the chat default", () => {
    const body = "yeah let's push the deploy to after lunch, the staging run is still going";
    expect(classifyRegister({ medium: "matrix", text: body, word_count: 14 })).toBe("chat");
  });

  test("a terse one-line email is overridden to chat", () => {
    expect(classifyRegister({ medium: "email", text: SHORT_EMAIL, word_count: 5 })).toBe("chat");
  });

  test("a terse matrix one-liner stays chat (already the default)", () => {
    expect(classifyRegister({ medium: "matrix", text: TERSE_CHAT, word_count: 2 })).toBe("chat");
  });

  test("a long structured email is overridden to longform", () => {
    const wordCount = LONGFORM_BODY.trim().split(/\s+/).length;
    expect(classifyRegister({ medium: "email", text: LONGFORM_BODY, word_count: wordCount })).toBe(
      "longform",
    );
  });

  test("a long structured matrix message is overridden to longform", () => {
    const wordCount = LONGFORM_BODY.trim().split(/\s+/).length;
    expect(classifyRegister({ medium: "matrix", text: LONGFORM_BODY, word_count: wordCount })).toBe(
      "longform",
    );
  });

  test("a mid-length message with no strong signal keeps the medium default", () => {
    // Neither clearly terse nor clearly long/structured → don't guess.
    const body =
      "I had a look at the proposal and it mostly works for me, though I would tweak the timeline a little before we commit";
    expect(classifyRegister({ medium: "email", text: body, word_count: 24 })).toBe("email");
    expect(classifyRegister({ medium: "matrix", text: body, word_count: 24 })).toBe("chat");
  });
});
