/**
 * Matrix source adapter (spec §6, §5 step 1).
 *
 * `pull()` returns the operator's own authored `m.text` messages as `RawUnit`s,
 * tagged with `medium: "matrix"` and provenance. The Matrix history source is
 * INJECTED (no live sync), so the own-authorship predicate is unit-testable in
 * isolation.
 *
 * Own-authorship predicate (the "authorized voices only" guardrail enforcement
 * point, §2): keep an event only when it is a `m.room.message` of `msgtype
 * m.text` whose sender is one of the operator's MXIDs. Third-party messages,
 * non-text content (images, files, notices), and system events (memberships)
 * are dropped here, before any processing, so their words never enter the corpus.
 */
import { readString } from "./read-field";
import type { RawUnit } from "./raw-unit";

/** Operator identity config (lives in the Second Brain in production, D3). */
export interface MatrixOperatorConfig {
  author_id: string;
  mxids: string[];
}

/**
 * The injectable Matrix history source. `fetch()` yields raw timeline events
 * from claude-matrix-channel history. Shape is intentionally loose
 * (`Record<string, unknown>`) so any backing store can satisfy it; the adapter
 * validates the fields it needs.
 */
export interface MatrixSource {
  fetch(): Promise<Array<Record<string, unknown>>>;
}

export interface MatrixAdapterDeps {
  source: MatrixSource;
  operator: MatrixOperatorConfig;
}

export interface MatrixAdapter {
  pull(): Promise<RawUnit[]>;
}

/** Read the event content sub-object, or undefined when absent/wrong-type. */
function readContent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = event["content"];
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : undefined;
}

/**
 * The own-authorship + text predicate (§6): an `m.room.message` of `msgtype
 * m.text` whose sender ∈ operator MXIDs. Returns the matched sender so the
 * caller can stamp it onto the unit without re-deriving it; undefined when the
 * event is not the operator's own natural-language message.
 */
function operatorSenderOf(
  event: Record<string, unknown>,
  operator: MatrixOperatorConfig,
): string | undefined {
  if (readString(event, "type") !== "m.room.message") {
    return undefined;
  }
  if (readContent(event)?.["msgtype"] !== "m.text") {
    return undefined;
  }
  const sender = readString(event, "sender");
  if (sender === undefined) {
    return undefined;
  }
  return operator.mxids.includes(sender) ? sender : undefined;
}

/**
 * Extract a thread root id from a Matrix reply relation (§4). Only an `m.thread`
 * relation is a thread; other relations (e.g. `m.replace` edits) are NOT, and
 * yield null so an edit is never mistaken for reply context.
 */
function threadIdOf(content: Record<string, unknown>): string | null {
  const relates = content["m.relates_to"];
  if (typeof relates !== "object" || relates === null) {
    return null;
  }
  const relation = relates as Record<string, unknown>;
  if (relation["rel_type"] !== "m.thread") {
    return null;
  }
  const eventId = relation["event_id"];
  return typeof eventId === "string" ? eventId : null;
}

/**
 * Convert Matrix `origin_server_ts` (epoch milliseconds) to an ISO-8601 string
 * (§4). Returns "" when absent/wrong-type so the downstream schema validation
 * fails fast on a malformed event rather than the adapter guessing a time.
 */
function timestampOf(event: Record<string, unknown>): string {
  const ts = event["origin_server_ts"];
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : "";
}

/** Build a RawUnit from an own-authored m.text event. Provenance + medium attached. */
function toRawUnit(
  event: Record<string, unknown>,
  content: Record<string, unknown>,
  operator: MatrixOperatorConfig,
  sender: string,
): RawUnit {
  const eventId = readString(event, "event_id") ?? "";
  return {
    author_id: operator.author_id,
    author_address: sender,
    medium: "matrix",
    source_uri: `matrix-event:${eventId}`,
    thread_id: threadIdOf(content),
    timestamp: timestampOf(event),
    raw_text: typeof content["body"] === "string" ? content["body"] : "",
  };
}

/**
 * Create a matrix adapter over an injected history source. `pull()` fetches,
 * keeps only operator-authored m.text events, and returns RawUnits — everything
 * else (third-party, non-text, system events) is dropped, never carried through.
 */
export function createMatrixAdapter(deps: MatrixAdapterDeps): MatrixAdapter {
  const { source, operator } = deps;
  return {
    async pull(): Promise<RawUnit[]> {
      const events = await source.fetch();
      const units: RawUnit[] = [];
      for (const event of events) {
        const sender = operatorSenderOf(event, operator);
        const content = readContent(event);
        if (sender !== undefined && content !== undefined) {
          units.push(toRawUnit(event, content, operator, sender));
        }
      }
      return units;
    },
  };
}
