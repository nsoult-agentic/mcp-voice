import { describe, expect, test } from "bun:test";

import { normalizeSafe, stripBoundaries } from "../src/boundary.ts";

// Boundary stripping (spec §5 step 3 + §8). The locked guarantee: remove other
// people's words and machine boilerplate, but PRESERVE the operator's kept text
// byte-for-byte (case, punctuation, em-dash, emoji, contractions, whitespace).
// Expected outputs are reasoned from the spec, not from any implementation.

describe("stripBoundaries — the multi-author reply example (§6 / D6)", () => {
  // The exact shape called out in the spec/prompt: a reply where the operator's
  // line sits above a quoted block from John, with a signature trailer.
  const reply = [
    "Yeah, I'll have them over to you tonight — I'm on it! 🙂",
    "",
    "On Tuesday, John wrote:",
    "> Can you get me the Q3 numbers before the board call?",
    "> Thanks,",
    "> John",
    "",
    "-- ",
    "Nico · sent from my phone",
  ].join("\n");

  const operatorLine = "Yeah, I'll have them over to you tonight — I'm on it! 🙂";

  test("only the operator's own line(s) survive", () => {
    const out = stripBoundaries(reply);
    expect(out).toBe(operatorLine);
  });

  test("zero third-party sentences remain (§10.1 guardrail)", () => {
    const out = stripBoundaries(reply);
    expect(out).not.toContain("Q3 numbers");
    expect(out).not.toContain("board call");
    expect(out).not.toContain("John");
    expect(out).not.toContain("On Tuesday");
    expect(out).not.toContain(">");
  });

  test("the signature trailer is stripped", () => {
    const out = stripBoundaries(reply);
    expect(out).not.toContain("sent from my phone");
    expect(out).not.toContain("--");
  });

  test("operator's kept text is byte-identical (PRESERVE: em-dash, emoji, contraction)", () => {
    const out = stripBoundaries(reply);
    // Em-dash, the 🙂 emoji, and the "I'll"/"I'm" contractions must survive intact.
    expect(out).toContain("—");
    expect(out).toContain("🙂");
    expect(out).toContain("I'll");
    expect(out).toContain("I'm");
    expect([...out]).toEqual([...operatorLine]); // code-point-identical
  });
});

describe("stripBoundaries — forwarded blocks and signatures", () => {
  test("removes a forwarded block, keeps the operator's intro", () => {
    const input = [
      "Passing this along — thoughts?",
      "",
      "---------- Forwarded message ---------",
      "From: Someone Else <else@example.com>",
      "Date: Mon, 1 Jun 2026",
      "Subject: FYI",
      "",
      "Here is the thing you should see.",
    ].join("\n");
    const out = stripBoundaries(input);
    expect(out).toBe("Passing this along — thoughts?");
    expect(out).not.toContain("Forwarded message");
    expect(out).not.toContain("Here is the thing");
  });

  test("removes a delimiter signature ('-- ' line and everything after)", () => {
    const input = ["Sounds good, let's ship it.", "", "-- ", "Nico", "CEO, Example Co"].join("\n");
    const out = stripBoundaries(input);
    expect(out).toBe("Sounds good, let's ship it.");
    expect(out).not.toContain("CEO");
  });

  test("text with no boundaries passes through unchanged", () => {
    const input = "Just a plain note from me — nothing to strip. 👍";
    expect(stripBoundaries(input)).toBe(input);
  });
});

describe("PRESERVE — never lowercase / strip punctuation / collapse whitespace (§8)", () => {
  test("case is preserved", () => {
    const input = "ACTUALLY Yes, This Is Fine.";
    expect(stripBoundaries(input)).toBe(input);
  });

  test("punctuation, em-dashes, emoji, contractions preserved byte-identical", () => {
    const input = "Don't worry — it's done!!! 🎉";
    const out = stripBoundaries(input);
    expect(out).toBe(input);
    expect([...out]).toEqual([...input]);
  });

  test("internal whitespace within a kept line is preserved", () => {
    const input = "two  spaces and a\ttab kept";
    expect(stripBoundaries(input)).toBe(input);
  });
});

describe("normalizeSafe — NORMALIZE-only ops (§8)", () => {
  test("applies Unicode NFC without altering visible voice tokens", () => {
    // "é" as a combining sequence (e + U+0301 combining acute) → NFC U+00E9.
    const decomposed = `Café — c'est bon! 🙂`;
    const out = normalizeSafe(decomposed);
    expect(out.normalize("NFC")).toBe(out); // result is already NFC
    expect(out).toBe("Café — c'est bon! 🙂");
    // Voice tokens survive: em-dash, contraction apostrophe, emoji.
    expect(out).toContain("—");
    expect(out).toContain("c'est");
    expect(out).toContain("🙂");
  });

  test("removes stray control characters but keeps visible text", () => {
    // NUL (U+0000) and BEL (U+0007) wedged between visible words.
    const input = `clean\u0000 \u0007text\u0007 here`;
    const out = normalizeSafe(input);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — asserts control chars are absent from normalized output
    expect(out).not.toMatch(/[\u0000-\u001f]/);
    expect(out).toContain("clean");
    expect(out).toContain("text");
    expect(out).toContain("here");
  });

  test("does NOT lowercase, strip punctuation, or remove emoji", () => {
    const input = "HELLO \u2014 World's best! \u{1F680}";
    const out = normalizeSafe(input);
    expect(out).toContain("HELLO");
    expect(out).toContain("—");
    expect(out).toContain("World's");
    expect(out).toContain("!");
    expect(out).toContain("🚀");
  });
});
