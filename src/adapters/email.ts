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

/** Operator identity config (lives in the Second Brain in production, D3). */
export interface OperatorConfig {
  author_id: string;
  addresses: string[];
}

/**
 * A raw, as-pulled unit. `raw_text` is the message body before boundary
 * stripping (that happens later, in the pipeline). No third-party text reaches
 * this type — it is filtered out upstream of construction.
 */
export interface RawUnit {
  author_id: string;
  author_address: string;
  medium: "email";
  source_uri: string;
  thread_id: string | null;
  timestamp: string;
  raw_text: string;
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
 * The own-authorship predicate (§6): From ∈ operator addresses AND folder is
 * "Sent". Returns the matched operator address so the caller can stamp it onto
 * the unit without re-deriving it.
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
  if (from === undefined || !operator.addresses.includes(from)) {
    return undefined;
  }
  return from;
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
