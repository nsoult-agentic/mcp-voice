/**
 * Exemplar store — tier-1 write path, read-back, and retrieval (spec 02 §3, §7, §8).
 *
 * Persists `CorpusRecord`s into `voice.exemplars`, keyed on the record's stable
 * `id` so re-ingesting unchanged content is a no-op (idempotent, §10.1). Both
 * embeddings are computed on write via the injected `Embedders` (S2). Only
 * `is_canonical` rows are embedded (they're the only ones served, §6); dedup
 * losers are still stored for provenance but carry NULL embeddings.
 *
 * `retrieve` is the generation-time primitive (§8): a HARD register pre-filter
 * (never crosses registers), style-primary RRF over style- and optional content-
 * cosine, always `is_canonical`. The register literal drives pgvector's per-
 * register partial HNSW indexes (§6).
 */
import { type CorpusRecord, type Medium, type Register, REGISTERS } from "./corpus-record";
import type { Sql } from "./db";
import type { Embedders } from "./embedder";
import { fuseRRF, type RankedList } from "./rrf";
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

export interface RetrieveOptions {
  author_id: string;
  /** HARD pre-filter — retrieval never crosses registers (§8). */
  register: Register;
  /** Text whose STYLE vector seeds ranking (the primary axis). */
  styleSeed?: string;
  /** Optional text for topical grounding (content axis, fused under style). */
  queryText?: string;
  /** Number of exemplars to return (3–10 per research; default 5). */
  k?: number;
}

export interface ExemplarStore {
  /** Upsert records; returns the count of newly inserted rows (existing ids are no-ops). */
  upsert(records: CorpusRecord[]): Promise<number>;
  getById(id: string): Promise<Exemplar | null>;
  getByIds(ids: string[]): Promise<Exemplar[]>;
  /** Register-scoped, style-primary RRF retrieval of canonical exemplars (§8). */
  retrieve(options: RetrieveOptions): Promise<Exemplar[]>;
}

export interface ExemplarStoreDeps {
  sql: Sql;
  embedders: Embedders;
}

const DEFAULT_K = 5;
/** Candidate pool per axis before fusion — over-fetch so fusion has room to work. */
const CANDIDATE_POOL_FACTOR = 4;
/** RRF weights: style is primary over content (§8, research §3 Area 5). */
const STYLE_WEIGHT = 2;
const CONTENT_WEIGHT = 1;

const VALID_REGISTERS = new Set<Register>(REGISTERS);

/**
 * Validate a register against the closed enum and return it as a safe SQL literal.
 * Retrieval interpolates the register as a literal (not a bound param) so the
 * planner can match the per-register partial HNSW index (§6) — this guard ensures
 * only an allow-listed value is ever interpolated.
 */
function registerLiteral(register: Register): string {
  if (!VALID_REGISTERS.has(register)) {
    throw new Error(`Unknown register: ${register}`);
  }
  return register;
}

/**
 * The columns selected for read-back. Vectors are cast to their text literal form
 * under DISTINCT alias names so they don't shadow the real vector columns — a
 * retrieval `ORDER BY style_embedding <=> ?` must bind the vector column, not the
 * text cast. (Keep in sync with `toExemplar`.)
 */
const SELECT_COLUMNS = `
  id, author_id, register, medium, source_uri, thread_id,
  authored_at, ingested_at, text, word_count, dedup_cluster_id, is_canonical,
  content_embedding::text AS content_embedding_text,
  style_embedding::text AS style_embedding_text,
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
    content_embedding: parseVectorLiteral(row["content_embedding_text"]),
    style_embedding: parseVectorLiteral(row["style_embedding_text"]),
    ingest_version: row["ingest_version"] as string,
    profile_version: (row["profile_version"] as string | null) ?? null,
  };
}

/**
 * One ANN candidate query on `column`, register-scoped. `reg` is interpolated as a
 * validated literal so the planner can use the per-register partial HNSW index
 * (§6); the embedding column is ORDER BY'd unqualified — it binds the vector
 * column, not the `*_text` read alias.
 */
async function annCandidates(
  sql: Sql,
  reg: string,
  column: "style_embedding" | "content_embedding",
  queryVector: string,
  authorId: string,
  limit: number,
): Promise<Exemplar[]> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SELECT_COLUMNS}
       FROM voice.exemplars
       WHERE register = '${reg}' AND is_canonical AND author_id = $2
         AND ${column} IS NOT NULL
       ORDER BY ${column} <=> $1::vector
       LIMIT $3`,
    [queryVector, authorId, limit],
  );
  return rows.map(toExemplar);
}

/** Recency fallback when no style/content seed is given (§8). */
async function recencyCandidates(
  sql: Sql,
  reg: string,
  authorId: string,
  limit: number,
): Promise<Exemplar[]> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SELECT_COLUMNS}
       FROM voice.exemplars
       WHERE register = '${reg}' AND is_canonical AND author_id = $1
       ORDER BY authored_at DESC
       LIMIT $2`,
    [authorId, limit],
  );
  return rows.map(toExemplar);
}

/** Index candidate rows by id and record their ranked id list + weight for fusion. */
function collectInto(
  rows: Exemplar[],
  weight: number,
  byId: Map<string, Exemplar>,
  lists: RankedList[],
): void {
  for (const row of rows) {
    byId.set(row.id, row);
  }
  lists.push({ ids: rows.map((row) => row.id), weight });
}

/** Take the first k fused ids that resolve to a candidate row, in fused order. */
function pickTopK(ordered: string[], byId: Map<string, Exemplar>, k: number): Exemplar[] {
  const result: Exemplar[] = [];
  for (const id of ordered) {
    const row = byId.get(id);
    if (row !== undefined) {
      result.push(row);
      if (result.length === k) {
        break;
      }
    }
  }
  return result;
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

      // Count rows ACTUALLY inserted via RETURNING — `ON CONFLICT DO NOTHING`
      // means a concurrent writer could have inserted the id between our SELECT
      // and this INSERT, so the SELECT snapshot would over-report.
      let inserted = 0;
      await sql.begin(async (tx) => {
        for (let i = 0; i < fresh.length; i += 1) {
          const record = fresh[i] as CorpusRecord;
          const pair = embeddings[i] as EmbeddingPair;
          const content = pair.content === null ? null : tx`${pair.content}::vector`;
          const style = pair.style === null ? null : tx`${pair.style}::vector`;
          const rows = await tx`
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
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;
          inserted += rows.length;
        }
      });

      return inserted;
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
      // Bind ids as a proper Postgres array. A bare string[] would be serialized
      // by porsager as a comma-joined scalar ("a,b,c") and rejected as a malformed
      // array literal; `sql.array` tags it with the array type so it serializes as
      // `{a,b,c}`.
      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `SELECT ${SELECT_COLUMNS} FROM voice.exemplars WHERE id = ANY($1::text[])`,
        [sql.array(ids)],
      );
      return rows.map(toExemplar);
    },

    async retrieve(options: RetrieveOptions): Promise<Exemplar[]> {
      const { author_id, styleSeed, queryText } = options;
      const k = options.k ?? DEFAULT_K;
      const reg = registerLiteral(options.register); // validated → safe literal
      const pool = Math.max(k * CANDIDATE_POOL_FACTOR, k);

      const byId = new Map<string, Exemplar>();
      const lists: RankedList[] = [];

      if (styleSeed !== undefined) {
        const vec = toVectorLiteral(await embedders.style.embed(styleSeed), STYLE_DIM);
        collectInto(
          await annCandidates(sql, reg, "style_embedding", vec, author_id, pool),
          STYLE_WEIGHT,
          byId,
          lists,
        );
      }

      if (queryText !== undefined) {
        const vec = toVectorLiteral(await embedders.content.embed(queryText), CONTENT_DIM);
        collectInto(
          await annCandidates(sql, reg, "content_embedding", vec, author_id, pool),
          CONTENT_WEIGHT,
          byId,
          lists,
        );
      }

      // No seed → recency fallback (most recently authored canonical rows).
      if (lists.length === 0) {
        return recencyCandidates(sql, reg, author_id, k);
      }

      return pickTopK(fuseRRF(lists), byId, k);
    },
  };
}
