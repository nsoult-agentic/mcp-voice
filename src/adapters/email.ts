/**
 * Email source adapter (spec §6, §5 step 1).
 *
 * `pull()` returns the operator's own authored email as `RawUnit`s, tagged with
 * `medium: "email"` and provenance. The mail source is INJECTED (no live IMAP),
 * so the own-authorship predicate is unit-testable in isolation.
 *
 * Own-authorship predicate (the "authorized voices only" guardrail enforcement
 * point, §2): keep a message only when its From address is one of the operator's
 * addresses AND it lives in the Sent folder. Third-party mail — and operator
 * mail sitting in INBOX (e.g. a note-to-self) — is dropped here, before any
 * processing, so its words never enter the corpus.
 */
import type { RawUnit } from "./raw-unit";

/** Operator identity config (lives in the Second Brain in production, D3). */
export interface OperatorConfig {
  author_id: string;
  addresses: string[];
}

/**
 * The injectable mail source. `fetch()` yields raw messages from the Sent store
 * / mcp-email. Shape is intentionally loose (`Record<string, unknown>`) so any
 * backing store can satisfy it; the adapter validates the fields it needs.
 */
export interface MailSource {
  fetch(): Promise<Array<Record<string, unknown>>>;
}

export interface EmailAdapterDeps {
  source: MailSource;
  operator: OperatorConfig;
}

export interface EmailAdapter {
  pull(): Promise<RawUnit[]>;
}

/** Read a string field from a raw message, or undefined when absent/wrong-type. */
function readString(message: Record<string, unknown>, key: string): string | undefined {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reduce a From header to a bare, case-folded address for comparison. Handles a
 * full header form like `"Nico" <nico@example.com>` by extracting the bracketed
 * address; a bare address is returned as-is. Lower-cased so the match is
 * case-insensitive without mutating the address stamped onto the unit.
 */
function normalizeAddress(raw: string): string {
  const bracketed = raw.match(/<([^>]+)>/);
  const address = bracketed?.[1] ?? raw;
  return address.trim().toLowerCase();
}

/**
 * The own-authorship predicate (§6): From ∈ operator addresses AND folder is
 * "Sent". The address match is case-insensitive and tolerates a display-name
 * header form. Returns the matched operator address so the caller can stamp it
 * onto the unit without re-deriving it.
 */
function operatorAddressOf(
  message: Record<string, unknown>,
  operator: OperatorConfig,
): string | undefined {
  const folder = readString(message, "folder");
  if (folder !== "Sent") {
    return undefined;
  }
  const from = readString(message, "from");
  if (from === undefined) {
    return undefined;
  }
  const fromAddress = normalizeAddress(from);
  return operator.addresses.find((address) => address.toLowerCase() === fromAddress);
}

/** Build a RawUnit from an own-authored message. Provenance + medium attached. */
function toRawUnit(
  message: Record<string, unknown>,
  operator: OperatorConfig,
  authorAddress: string,
): RawUnit {
  const messageId = readString(message, "message_id") ?? "";
  const threadId = readString(message, "thread_id");
  return {
    author_id: operator.author_id,
    author_address: authorAddress,
    medium: "email",
    source_uri: `message-id:${messageId}`,
    thread_id: threadId ?? null,
    timestamp: readString(message, "date") ?? "",
    raw_text: readString(message, "body") ?? "",
  };
}

/**
 * Create an email adapter over an injected mail source. `pull()` fetches, keeps
 * only operator-authored Sent mail, and returns RawUnits — third-party mail is
 * dropped entirely, never carried through.
 */
export function createEmailAdapter(deps: EmailAdapterDeps): EmailAdapter {
  const { source, operator } = deps;
  return {
    async pull(): Promise<RawUnit[]> {
      const messages = await source.fetch();
      const units: RawUnit[] = [];
      for (const message of messages) {
        const authorAddress = operatorAddressOf(message, operator);
        if (authorAddress !== undefined) {
          units.push(toRawUnit(message, operator, authorAddress));
        }
      }
      return units;
    },
  };
}
