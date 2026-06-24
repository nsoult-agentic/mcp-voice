import { describe, expect, test } from "bun:test";

import { CONTENT_DIM, parseVectorLiteral, STYLE_DIM, toVectorLiteral } from "../src/vector.ts";

// pgvector literal formatting (spec 02 §5). Pure — no DB. Validates dimension +
// finiteness on the way out, parses the driver's literal string on the way back.

describe("toVectorLiteral", () => {
  test("formats a vector of the expected dimension", () => {
    expect(toVectorLiteral([1, 2, 3], 3)).toBe("[1,2,3]");
  });

  test("rejects a wrong-length vector", () => {
    expect(() => toVectorLiteral([1, 2], 3)).toThrow(/exactly 3 dimensions, got 2/);
  });

  test("rejects a non-finite value", () => {
    expect(() => toVectorLiteral([1, Number.NaN, 3], 3)).toThrow(/non-finite value at index 1/);
    expect(() => toVectorLiteral([1, Number.POSITIVE_INFINITY], 2)).toThrow(/non-finite/);
  });

  test("content and style dimension constants are positive integers", () => {
    expect(Number.isInteger(CONTENT_DIM) && CONTENT_DIM > 0).toBe(true);
    expect(Number.isInteger(STYLE_DIM) && STYLE_DIM > 0).toBe(true);
  });
});

describe("parseVectorLiteral", () => {
  test("returns null for a NULL column", () => {
    expect(parseVectorLiteral(null)).toBeNull();
    expect(parseVectorLiteral(undefined)).toBeNull();
  });

  test("parses a pgvector literal string", () => {
    expect(parseVectorLiteral("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("parses an empty vector literal", () => {
    expect(parseVectorLiteral("[]")).toEqual([]);
  });

  test("round-trips with toVectorLiteral", () => {
    const vec = [0.1, -0.2, 0.3, 0.4];
    expect(parseVectorLiteral(toVectorLiteral(vec, 4))).toEqual(vec);
  });
});
