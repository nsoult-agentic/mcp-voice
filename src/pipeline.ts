/**
 * Ingestion pipeline (spec §5).
 *
 * Ordered, pure, idempotent stages turning own-authored `RawUnit`s into
 * canonical `CorpusRecord`s:
 *
 *   boundary strip → word count → dedup → register classification → emit
 *
 * Slice 1 implements the dedup and register stages as deterministic
 * pass-throughs, leaving clean seams for slice 2 (MinHash/LSH dedup, content
 * register classification). Own-authorship filtering already happened in the
 * adapter, so every input here is the operator's own text.
 *
 * Idempotency (§5, §10.3): a record's `id` is a content+provenance hash, so the
 * same unit always yields the same id regardless of run or batch order, and
 * identical units within a batch collapse to a single record.
 */
import {
  computeId,
  type CorpusRecord,
  CorpusRecordSchema,
  MEDIUM_REGISTER_DEFAULT,
  type Medium,
  type Register,
} from "./corpus-record";
import { normalizeSafe, stripBoundaries } from "./boundary";
import type { RawUnit } from "./adapters/email";

export interface PipelineOptions {
  ingest_version: string;
}

/** Count words in cleaned text: whitespace-delimited, empty tokens dropped. */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

/**
 * Map a medium to its default register (§3). Slice 1 always takes the default;
 * the content classifier that may override it is a deferred seam (slice 2).
 */
function classifyRegister(medium: Medium): Register {
  return MEDIUM_REGISTER_DEFAULT[medium];
}

/**
 * Validate a constructed record through the canonical schema (§4) before it can
 * leave the pipeline. A schema-invalid record means the adapter contract was
 * violated (e.g. a non-ISO timestamp); fail fast and name the offending source,
 * rather than silently dropping or emitting a malformed record.
 */
function assertValidRecord(record: CorpusRecord): CorpusRecord {
  const result = CorpusRecordSchema.safeParse(record);
  if (!result.success) {
    throw new Error(
      `Invalid CorpusRecord for source_uri ${record.source_uri}: ${result.error.message}`,
    );
  }
  return result.data;
}

/** Transform one raw unit into a canonical record (single-unit pure stage). */
function toRecord(unit: RawUnit, options: PipelineOptions): CorpusRecord {
  // Boundary strip (drop others' words) then NORMALIZE-only (NFC + control-char
  // removal, §8). PRESERVE holds: voice tokens stay byte-identical.
  const textClean = normalizeSafe(stripBoundaries(unit.raw_text));
  const id = computeId({
    author_id: unit.author_id,
    medium: unit.medium,
    source_uri: unit.source_uri,
    content: textClean,
  });
  const record: CorpusRecord = {
    id,
    author_id: unit.author_id,
    medium: unit.medium,
    register: classifyRegister(unit.medium),
    source_uri: unit.source_uri,
    thread_id: unit.thread_id,
    timestamp: unit.timestamp,
    text_clean: textClean,
    word_count: countWords(textClean),
    // Dedup pass-through (slice 1): every record is its own cluster's canonical.
    dedup_cluster_id: id,
    is_canonical: true,
    ingest_version: options.ingest_version,
  };
  return assertValidRecord(record);
}

/**
 * Run the pipeline over a batch of raw units, emitting canonical records.
 * Deterministic and idempotent: identical units collapse on their shared id
 * (first occurrence wins), so re-ingesting an unchanged source produces no
 * duplicate records.
 */
export function runPipeline(units: RawUnit[], options: PipelineOptions): CorpusRecord[] {
  const byId = new Map<string, CorpusRecord>();
  for (const unit of units) {
    const record = toRecord(unit, options);
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}
