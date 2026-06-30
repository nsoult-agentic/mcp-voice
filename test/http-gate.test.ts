import { describe, expect, test } from "bun:test";

import { isRateLimited, mcpGate, type RateWindow } from "../src/http-gate.ts";

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

describe("mcpGate", () => {
  const mcpReq = (xff?: string): Request =>
    new Request("http://127.0.0.1:8919/mcp", {
      method: "POST",
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    });

  // Regression for second-brain #2526: the app no longer enforces an IP allowlist.
  // Access control lives at the NPM proxy only; a proxied request whose first XFF hop
  // is NOT on any allowlist must NOT be rejected by the app's gate — it proceeds (and is
  // still subject to rate limiting). This would have been a 403 before the IP gate was
  // removed.
  test("does not 403 a request from a non-allowlisted client IP", () => {
    const w: RateWindow = { start: 0, count: 0 };
    expect(mcpGate(mcpReq("10.0.0.99"), w, 1000, 60_000, 120)).toBeNull();
    // a spoofed extra hop is likewise irrelevant — origin is never inspected
    expect(mcpGate(mcpReq("10.0.0.99, 172.16.10.50"), w, 1000, 60_000, 120)).toBeNull();
    // and a direct loopback request (no XFF) still proceeds
    expect(mcpGate(mcpReq(undefined), w, 1000, 60_000, 120)).toBeNull();
  });

  test("still rate-limits regardless of origin (429 over cap)", () => {
    const w: RateWindow = { start: 0, count: 0 };
    // first request under the cap of 1 proceeds…
    expect(mcpGate(mcpReq("10.0.0.99"), w, 1000, 60_000, 1)).toBeNull();
    // …the second in the window is rejected with 429 (abuse protection retained)
    const limited = mcpGate(mcpReq("10.0.0.99"), w, 1000, 60_000, 1);
    expect(limited).not.toBeNull();
    expect(limited?.status).toBe(429);
  });
});
