/**
 * Exemplar store — tier-1 write path + read-back (spec 02 §3, §7).
 *
 * Persists `CorpusRecord`s into `voice.exemplars`, keyed on the record's stable
 * `id` so re-ingesting unchanged content is a no-op (idempotent, §10.1). Both
 * embeddings are computed on write via the injected `Embedders` (S2). Only
 * `is_canonical` rows are embedded (they're the only ones served, §6); dedup
 * losers are still stored for provenance but carry NULL embeddings.
 *
 * Retrieval (register-filtered, style-ranked) is a later slice; this slice
 * provides the write path and id-keyed read-back the round-trip/isolation
 * acceptance criteria need.
 */
import type { CorpusRecord, Medium, Register } from "./corpus-record";
import type { Sql } from "./db";
import type { Embedders } from "./embedder";
import { CONTENT_DIM, parseVectorLiteral, STYLE_DIM, toVectorLiteral } from "./vector";

export interface Exemplar {
  id: string;
  author_id: string;
  register: Register;
  medium: Medium;
  source_uri: string;
  thread_id: string | null;
  authored_at: string;
  ingested_at: string;
  text: string;
  word_count: number;
  dedup_cluster_id: string;
  is_canonical: boolean;
  content_embedding: number[] | null;
  style_embedding: number[] | null;
  ingest_version: string;
  profile_version: string | null;
}

export interface ExemplarStore {
  /** Upsert records; returns the count of newly inserted rows (existing ids are no-ops). */
  upsert(records: CorpusRecord[]): Promise<number>;
  getById(id: string): Promise<Exemplar | null>;
  getByIds(ids: string[]): Promise<Exemplar[]>;
}

export interface ExemplarStoreDeps {
  sql: Sql;
  embedders: Embedders;
}

/** The columns selected for read-back, with vectors cast to their text literal form. */
const SELECT_COLUMNS = `
  id, author_id, register, medium, source_uri, thread_id,
  authored_at, ingested_at, text, word_count, dedup_cluster_id, is_canonical,
  content_embedding::text AS content_embedding,
  style_embedding::text AS style_embedding,
  ingest_version, profile_version`;

/** Map a raw DB row to an Exemplar (timestamps → ISO, vectors → number[] | null). */
function toExemplar(row: Record<string, unknown>): Exemplar {
  return {
    id: row["id"] as string,
    author_id: row["author_id"] as string,
    register: row["register"] as Register,
    medium: row["medium"] as Medium,
    source_uri: row["source_uri"] as string,
    thread_id: (row["thread_id"] as string | null) ?? null,
    authored_at: (row["authored_at"] as Date).toISOString(),
    ingested_at: (row["ingested_at"] as Date).toISOString(),
    text: row["text"] as string,
    word_count: row["word_count"] as number,
    dedup_cluster_id: row["dedup_cluster_id"] as string,
    is_canonical: row["is_canonical"] as boolean,
    content_embedding: parseVectorLiteral(row["content_embedding"]),
    style_embedding: parseVectorLiteral(row["style_embedding"]),
    ingest_version: row["ingest_version"] as string,
    profile_version: (row["profile_version"] as string | null) ?? null,
  };
}

/** Computed embeddings for one record (null when the record is not canonical). */
interface EmbeddingPair {
  content: string | null;
  style: string | null;
}

/** Create the exemplar store over an injected pool + embedders. */
export function createExemplarStore(deps: ExemplarStoreDeps): ExemplarStore {
  const { sql, embedders } = deps;

  async function embedCanonical(record: CorpusRecord): Promise<EmbeddingPair> {
    if (!record.is_canonical) {
      return { content: null, style: null };
    }
    const [content, style] = await Promise.all([
      embedders.content.embed(record.text_clean),
      embedders.style.embed(record.text_clean),
    ]);
    return {
      content: toVectorLiteral(content, CONTENT_DIM),
      style: toVectorLiteral(style, STYLE_DIM),
    };
  }

  return {
    async upsert(records: CorpusRecord[]): Promise<number> {
      // Collapse duplicate ids within the batch (last wins) before touching the DB.
      const byId = new Map(records.map((record) => [record.id, record]));
      const unique = [...byId.values()];
      if (unique.length === 0) {
        return 0;
      }

      // id encodes content+provenance, so an existing id means identical content:
      // skip it entirely (no re-embed, true no-op) — that is our idempotency.
      const ids = unique.map((record) => record.id);
      const existing = await sql<{ id: string }[]>`
        SELECT id FROM voice.exemplars WHERE id IN ${sql(ids)}`;
      const existingIds = new Set(existing.map((row) => row.id));
      const fresh = unique.filter((record) => !existingIds.has(record.id));
      if (fresh.length === 0) {
        return 0;
      }

      const embeddings = await Promise.all(fresh.map((record) => embedCanonical(record)));

      await sql.begin(async (tx) => {
        for (let i = 0; i < fresh.length; i += 1) {
          const record = fresh[i] as CorpusRecord;
          const pair = embeddings[i] as EmbeddingPair;
          const content = pair.content === null ? null : tx`${pair.content}::vector`;
          const style = pair.style === null ? null : tx`${pair.style}::vector`;
          await tx`
            INSERT INTO voice.exemplars (
              id, author_id, register, medium, source_uri, thread_id,
              authored_at, text, word_count, dedup_cluster_id, is_canonical,
              content_embedding, style_embedding, ingest_version
            ) VALUES (
              ${record.id}, ${record.author_id}, ${record.register}::voice.register,
              ${record.medium}, ${record.source_uri}, ${record.thread_id},
              ${record.timestamp}, ${record.text_clean}, ${record.word_count},
              ${record.dedup_cluster_id}, ${record.is_canonical},
              ${content}, ${style}, ${record.ingest_version}
            )
            ON CONFLICT (id) DO NOTHING`;
        }
      });

      return fresh.length;
    },

    async getById(id: string): Promise<Exemplar | null> {
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SELECT_COLUMNS} FROM voice.exemplars WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : toExemplar(row);
    },

    async getByIds(ids: string[]): Promise<Exemplar[]> {
      if (ids.length === 0) {
        return [];
      }
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SELECT_COLUMNS} FROM voice.exemplars WHERE id = ANY($1::text[])`,
        [ids],
      );
      return rows.map(toExemplar);
    },
  };
}
