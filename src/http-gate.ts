/**
 * Abuse-protection gate for the /mcp HTTP route — the rate-limit decision, factored out
 * of `src/http.ts` so it's unit-testable without booting the server/engine. Pure
 * function only (the limiter takes its window state as an argument); `http.ts` owns the
 * singleton state and wiring.
 *
 * NOTE: this server performs NO app-level access control. Access is enforced solely at
 * the NPM reverse proxy (fleet policy, second-brain #2526); the container binds
 * 127.0.0.1 only and is reachable just via that proxy or loopback, so every request the
 * app receives is already trusted. Rate limiting below is abuse protection, not access
 * control, and stays.
 */

/** Mutable counter window for {@link isRateLimited}. */
export interface RateWindow {
  start: number;
  count: number;
}

/**
 * Coarse fixed-window limiter: at most `max` requests per `windowMs`. Mutates `window`
 * in place and returns true when the current request exceeds the cap. The window is a
 * runaway-client backstop (the operator is the only caller), not a fairness scheduler.
 */
export function isRateLimited(
  window: RateWindow,
  now: number,
  windowMs: number,
  max: number,
): boolean {
  if (now - window.start >= windowMs) {
    window.start = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count > max;
}

/**
 * Pre-engine gate for the /mcp route. The ONLY decision here is abuse protection: return
 * a 429 Response when the fixed-window rate limit is exceeded, otherwise `null` to let
 * the request proceed to the MCP transport. Mutates `window` in place.
 *
 * Deliberately performs NO access control — it does not read `X-Forwarded-For` or any
 * other origin signal. Access is enforced upstream at the NPM reverse proxy (fleet
 * policy, second-brain #2526); the container binds 127.0.0.1 only, so every request the
 * app sees is already trusted. `req` is accepted for symmetry with other fleet gates and
 * to keep a single call site, but its origin is intentionally not inspected.
 */
export function mcpGate(
  _req: Request,
  window: RateWindow,
  now: number,
  windowMs: number,
  max: number,
): Response | null {
  if (isRateLimited(window, now, windowMs, max)) {
    return new Response("Rate limit exceeded", { status: 429 });
  }
  return null;
}
