/**
 * RawUnit — the shared adapter output contract (spec §5 step 1).
 *
 * Every source adapter (`email`, `matrix`) emits `RawUnit`s: the operator's own
 * authored text, post own-authorship filter, BEFORE boundary stripping and
 * normalization (those happen later in the pipeline). No third-party text ever
 * reaches this type — it is dropped at the adapter, before construction.
 */
import type { Medium } from "../corpus-record";

export interface RawUnit {
  /** Authorized author id; "operator" for v1. */
  author_id: string;
  /** The operator identity matched at the source: an email address or Matrix MXID. */
  author_address: string;
  /** Where the text came from (the source channel). Set by the adapter. */
  medium: Medium;
  /** Provenance: an email message-id or a matrix event id. */
  source_uri: string;
  /** Reply-context grouping key, or null when the unit is standalone. */
  thread_id: string | null;
  /** Original authored time, ISO 8601. */
  timestamp: string;
  /** The message body before boundary stripping (done later, in the pipeline). */
  raw_text: string;
}
