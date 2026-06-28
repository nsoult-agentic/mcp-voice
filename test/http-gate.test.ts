import { describe, expect, test } from "bun:test";

import {
  isClientAllowed,
  isRateLimited,
  parseAllowedIps,
  type RateWindow,
} from "../src/http-gate.ts";

describe("parseAllowedIps", () => {
  test("splits, trims, and drops empties", () => {
    expect([...parseAllowedIps("172.16.10.50, 10.0.0.1 ,")]).toEqual(["172.16.10.50", "10.0.0.1"]);
  });

  test("unset → empty set (loopback-only)", () => {
    expect(parseAllowedIps(undefined).size).toBe(0);
    expect(parseAllowedIps("").size).toBe(0);
  });
});

describe("isClientAllowed", () => {
  const allowed = parseAllowedIps("172.16.10.50");

  test("direct loopback (no XFF) is always allowed", () => {
    expect(isClientAllowed(null, allowed)).toBe(true);
    // even with an empty allowlist
    expect(isClientAllowed(null, new Set())).toBe(true);
  });

  test("proxied request from an allowlisted IP is allowed", () => {
    expect(isClientAllowed("172.16.10.50", allowed)).toBe(true);
  });

  test("uses the first XFF hop (the originating client), trimmed", () => {
    expect(isClientAllowed("172.16.10.50, 10.9.9.9", allowed)).toBe(true);
    expect(isClientAllowed(" 172.16.10.50 ", allowed)).toBe(true);
  });

  test("proxied request from a non-allowlisted IP is rejected", () => {
    expect(isClientAllowed("10.0.0.99", allowed)).toBe(false);
    // a spoofed downstream hop can't smuggle in: only the first hop counts
    expect(isClientAllowed("10.0.0.99, 172.16.10.50", allowed)).toBe(false);
  });

  test("any proxied request is rejected when the allowlist is empty", () => {
    expect(isClientAllowed("172.16.10.50", new Set())).toBe(false);
  });
});

describe("isRateLimited", () => {
  test("allows up to max within a window, then limits", () => {
    const w: RateWindow = { start: 0, count: 0 };
    for (let i = 0; i < 3; i += 1) {
      expect(isRateLimited(w, 1000, 60_000, 3)).toBe(false);
    }
    expect(isRateLimited(w, 1000, 60_000, 3)).toBe(true); // 4th in the window
  });

  test("window resets after windowMs elapses", () => {
    const w: RateWindow = { start: 0, count: 0 };
    expect(isRateLimited(w, 1000, 60_000, 1)).toBe(false);
    expect(isRateLimited(w, 1000, 60_000, 1)).toBe(true); // over cap in window 1
    // jump past the window → counter resets, request allowed again
    expect(isRateLimited(w, 1000 + 60_000, 60_000, 1)).toBe(false);
  });
});
