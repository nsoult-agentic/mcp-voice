/**
 * Ingestion pipeline (spec §5).
 *
 * Ordered, pure, idempotent stages turning own-authored `RawUnit`s into
 * canonical `CorpusRecord`s:
 *
 *   boundary strip → word count → dedup → register classification → emit
 *
 * Boundary stripping is medium-dispatched (email keeps the lead and drops from
 * the first quote/signature; matrix drops the leading reply-fallback block).
 * Dedup is MinHash/LSH near-duplicate clustering (keep-earliest); register is a
 * default-plus-strong-signal content classifier. Own-authorship filtering
 * already happened in the adapter, so every input here is the operator's text.
 *
 * Idempotency (§5, §10.3): a record's `id` is a content+provenance hash, so the
 * same unit always yields the same id regardless of run or batch order, and
 * identical units within a batch collapse to a single record.
 */
import { computeId, type CorpusRecord, CorpusRecordSchema, type Medium } from "./corpus-record";
import { normalizeSafe, stripBoundaries, stripMatrixBoundaries } from "./boundary";
import { dedup } from "./dedup";
import { classifyRegister } from "./register";
import type { RawUnit } from "./adapters/raw-unit";

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
 * Strip boundaries with the rule for the unit's medium (§5 step 3). Email and
 * Matrix place quoted text on opposite ends, so each needs its own stripper.
 */
function stripFor(medium: Medium, rawText: string): string {
  return medium === "matrix" ? stripMatrixBoundaries(rawText) : stripBoundaries(rawText);
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

/**
 * Transform one raw unit into a canonical record (single-unit pure stage). The
 * dedup fields are seeded as a singleton (its own cluster, canonical); the
 * batch-level dedup pass in `runPipeline` then rewrites them for near-duplicates.
 */
function toRecord(unit: RawUnit, options: PipelineOptions): CorpusRecord {
  // Boundary strip (drop others' words) then NORMALIZE-only (NFC + control-char
  // removal, §8). PRESERVE holds: voice tokens stay byte-identical.
  const textClean = normalizeSafe(stripFor(unit.medium, unit.raw_text));
  const id = computeId({
    author_id: unit.author_id,
    medium: unit.medium,
    source_uri: unit.source_uri,
    content: textClean,
  });
  const wordCount = countWords(textClean);
  const record: CorpusRecord = {
    id,
    author_id: unit.author_id,
    medium: unit.medium,
    register: classifyRegister({ medium: unit.medium, text: textClean, word_count: wordCount }),
    source_uri: unit.source_uri,
    thread_id: unit.thread_id,
    timestamp: unit.timestamp,
    text_clean: textClean,
    word_count: wordCount,
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
 * duplicate records. Near-duplicates are kept but clustered — only the earliest
 * is `is_canonical`, and all members share its `dedup_cluster_id` (§8, D4).
 */
export function runPipeline(units: RawUnit[], options: PipelineOptions): CorpusRecord[] {
  // 1. Build + validate base records, collapsing exact-id duplicates (idempotency).
  const byId = new Map<string, CorpusRecord>();
  const ordered: CorpusRecord[] = [];
  for (const unit of units) {
    const record = toRecord(unit, options);
    if (!byId.has(record.id)) {
      byId.set(record.id, record);
      ordered.push(record);
    }
  }

  // 2. Near-duplicate dedup across the batch (MinHash/LSH, keep-earliest).
  const clusters = dedup(
    ordered.map((record) => ({
      id: record.id,
      text: record.text_clean,
      timestamp: record.timestamp,
    })),
  );

  // 3. Stamp cluster membership onto each record.
  return ordered.map((record) => {
    const cluster = clusters.get(record.id);
    return cluster === undefined
      ? record
      : {
          ...record,
          dedup_cluster_id: cluster.dedup_cluster_id,
          is_canonical: cluster.is_canonical,
        };
  });
}
