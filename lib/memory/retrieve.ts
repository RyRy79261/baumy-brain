import { sql } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { embed, EMBED_MODEL } from '@/lib/ai/embed'

// Retrieval helper (task-graph M3) — HYBRID recall (memory Phase 2). Fuses two
// rankings with Reciprocal Rank Fusion (RRF): semantic (pgvector cosine ANN over
// Voyage embeddings) catches paraphrases; lexical (Postgres full-text over the
// generated content_tsv) catches exact terms embeddings miss — names, codes, rare
// nouns ("tortilla press", "hunter2"). RRF ( Σ 1/(k+rank) ) needs no score
// calibration between the two spaces, just their rank orders. Group-scoped,
// active-only, quarantined excluded (poisoning wall), current embedding model only.
const RRF_K = 60 // standard RRF damping constant
const CANDIDATES = 50 // per-list candidate pool feeding the fusion

export interface RetrievedMemory {
  id: string
  content: string
  memoryType: string
  authoredBy: string | null
  /** Cosine similarity to the query (0 for a lexical-only hit — no vector rank). */
  similarity: number
  isSecure: boolean
  /** AES-GCM blob for a secure value; decrypt ONLY to answer a direct request. */
  contentEncrypted: string | null
}

export interface RetrieveOpts {
  groupId: string
  k?: number
  floor?: number
}

export async function retrieve(
  query: string,
  opts: RetrieveOpts,
  deps?: { db?: Database; embed?: (t: string) => Promise<number[]> },
): Promise<RetrievedMemory[]> {
  const db = deps?.db ?? createHttpDb()
  const embedFn = deps?.embed ?? embed
  const q = await embedFn(query)
  const vec = `[${q.join(',')}]` // pgvector text literal, bound + cast to ::vector
  const k = opts.k ?? 8
  const floor = opts.floor ?? 0.2

  // One SQL statement: build two ranked candidate lists, FULL OUTER JOIN them, and
  // sum their RRF contributions. A lexical hit ALWAYS survives the floor (real term
  // overlap is relevance by construction); a semantic-only hit must clear the floor,
  // preserving the old "honest miss" behaviour for distant vectors.
  const result = await db.execute(sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${query}) AS tsq),
    semantic AS (
      SELECT me.memory_item_id AS id,
             row_number() OVER (ORDER BY me.embedding <=> ${vec}::vector) AS rank,
             1 - (me.embedding <=> ${vec}::vector) AS sim
      FROM baumy_memory_embeddings me
      JOIN baumy_memory_items mi ON mi.id = me.memory_item_id
      WHERE mi.group_id = ${opts.groupId}
        AND mi.is_active = true
        AND mi.trust_level <> 'quarantined'
        AND me.model = ${EMBED_MODEL}
      ORDER BY me.embedding <=> ${vec}::vector
      LIMIT ${CANDIDATES}
    ),
    lexical AS (
      SELECT mi.id AS id,
             row_number() OVER (ORDER BY ts_rank_cd(mi.content_tsv, q.tsq) DESC) AS rank
      FROM baumy_memory_items mi, q
      WHERE mi.group_id = ${opts.groupId}
        AND mi.is_active = true
        AND mi.trust_level <> 'quarantined'
        AND mi.content_tsv @@ q.tsq
      ORDER BY ts_rank_cd(mi.content_tsv, q.tsq) DESC
      LIMIT ${CANDIDATES}
    ),
    fused AS (
      SELECT COALESCE(s.id, l.id) AS id,
             COALESCE(1.0 / (${RRF_K} + s.rank), 0) + COALESCE(1.0 / (${RRF_K} + l.rank), 0) AS rrf,
             COALESCE(s.sim, 0) AS sim,
             (l.id IS NOT NULL) AS lex_hit
      FROM semantic s FULL OUTER JOIN lexical l ON s.id = l.id
    )
    SELECT mi.id AS id,
           mi.content AS content,
           mi.memory_type AS "memoryType",
           mi.authored_by AS "authoredBy",
           mi.is_secure AS "isSecure",
           mi.content_encrypted AS "contentEncrypted",
           f.sim AS "similarity"
    FROM fused f
    JOIN baumy_memory_items mi ON mi.id = f.id
    WHERE f.lex_hit = true OR f.sim >= ${floor}
    ORDER BY f.rrf DESC
    LIMIT ${k}
  `)

  // Normalise across drivers: neon-http / node-postgres / pglite return either the
  // rows array directly or a { rows } envelope.
  const rows: Record<string, unknown>[] = Array.isArray(result)
    ? result
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? [])

  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    memoryType: r.memoryType as string,
    authoredBy: (r.authoredBy ?? null) as string | null,
    similarity: Number(r.similarity),
    isSecure: Boolean(r.isSecure),
    contentEncrypted: (r.contentEncrypted ?? null) as string | null,
  }))
}
