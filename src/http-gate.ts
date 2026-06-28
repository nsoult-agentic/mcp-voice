/**
 * Access gate for the /mcp HTTP route — the security-relevant decisions, factored out
 * of `src/http.ts` so they're unit-testable without booting the server/engine. Pure
 * functions only (the rate limiter takes its window state as an argument); `http.ts`
 * owns the singleton state and wiring.
 */

/** Parse `MCP_ALLOWED_IPS` (comma-separated) into a set of trimmed, non-empty IPs. */
export function parseAllowedIps(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Decide whether a request may reach /mcp. A request with no `X-Forwarded-For` is a
 * direct loopback connection (the reverse proxy always sets XFF) and is allowed; a
 * proxied request is allowed only if its originating client IP (the first XFF hop) is
 * on the allowlist.
 */
export function isClientAllowed(
  forwardedFor: string | null,
  allowed: ReadonlySet<string>,
): boolean {
  if (forwardedFor === null) {
    return true;
  }
  const clientIp = forwardedFor.split(",")[0]?.trim() ?? "";
  return allowed.has(clientIp);
}

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
