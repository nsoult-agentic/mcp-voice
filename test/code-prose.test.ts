import { describe, expect, test } from "bun:test";

import { stripCode } from "../src/code-prose.ts";

// Code/prose split (spec §5 step 4, §2): separate prose from embedded code
// blocks — code is excluded from the prose corpus because it isn't natural-
// language voice. v1 removes FENCED code blocks (``` … ```); inline `code` spans
// stay (removing them mid-sentence would damage the surrounding voice). Prose is
// preserved byte-identical (PRESERVE, §8); a message with no fence is untouched.

describe("stripCode — fenced-block removal (§5 step 4)", () => {
  test("text with no code fence is returned unchanged", () => {
    const body = "just a normal message — nothing technical here 🙂";
    expect(stripCode(body)).toBe(body);
  });

  test("a fenced code block is removed, surrounding prose kept", () => {
    const body = "here's the fix:\n\n```\nconst x = 1;\n```\n\nlet me know if that works";
    expect(stripCode(body)).toBe("here's the fix:\n\nlet me know if that works");
  });

  test("a language-tagged fence is removed", () => {
    const body = "try this:\n```ts\nexport const y = 2;\n```\ndone";
    expect(stripCode(body)).toBe("try this:\ndone");
  });

  test("a message that is entirely code becomes empty", () => {
    const body = "```python\nprint('hi')\n```";
    expect(stripCode(body)).toBe("");
  });

  test("inline code spans are preserved (not removed)", () => {
    const body = "run `bun test` and check the `dedup` module";
    expect(stripCode(body)).toBe(body);
  });

  test("multiple fenced blocks are all removed", () => {
    const body = "first:\n```\na\n```\nthen:\n```\nb\n```\nfin";
    expect(stripCode(body)).toBe("first:\nthen:\nfin");
  });

  test("prose voice tokens around code survive byte-identically", () => {
    const body = "Honestly? — this 😅:\n```\ncode\n```\nis cursed";
    expect(stripCode(body)).toBe("Honestly? — this 😅:\nis cursed");
  });

  test("an unterminated fence drops everything from the fence onward", () => {
    const body = "see below\n```\nhalf a block with no close";
    expect(stripCode(body)).toBe("see below");
  });
});
