import { sql } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { embed, embedMany, EMBED_MODEL } from '@/lib/ai/embed'

// Retrieval (task-graph M3). HYBRID recall (Phase 2) fused with MULTI-PROBE query
// expansion (Phase 4) and a mild RECENCY composition (Phase 5). Each probe runs a
// hybrid pass — semantic (pgvector cosine over Voyage) ⊕ lexical (Postgres full-text
// over content_tsv) fused by Reciprocal Rank Fusion — and multiple probes (the query
// + LLM paraphrases + a HyDE answer) are RRF-fused again across probes, so recall no
// longer hinges on the asker's exact wording. Group-scoped, active-only, quarantined
// excluded (poisoning wall), current embedding model only.
const RRF_K = 60 // standard RRF damping constant
const CANDIDATES = 50 // per-probe candidate pool feeding the fusion
const RECENCY_HALFLIFE_DAYS = 30 // recency decay half-life
const RECENCY_WEIGHT = 0.25 // max fractional score boost for a brand-new memory (relevance still dominates)

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
  createdAt?: string
}

export interface RetrieveOpts {
  groupId: string
  k?: number
  floor?: number
}

export interface RetrieveDeps {
  db?: Database
  embed?: (t: string) => Promise<number[]>
  embedMany?: (t: string[]) => Promise<number[][]>
}

// One hybrid probe: semantic ⊕ lexical, RRF-fused, floor-filtered. Returns up to
// CANDIDATES rows in probe-relevance order, each carrying its RRF score, cosine
// similarity and age (for cross-probe fusion + recency composition upstream).
interface ProbeRow extends RetrievedMemory {
  rrf: number
}

async function runHybrid(
  db: Database,
  vec: number[],
  lexicalQuery: string,
  groupId: string,
  floor: number,
): Promise<ProbeRow[]> {
  const v = `[${vec.join(',')}]` // pgvector text literal, bound + cast to ::vector
  const result = await db.execute(sql`
    WITH q AS (SELECT websearch_to_tsquery('english', ${lexicalQuery}) AS tsq),
    semantic AS (
      SELECT me.memory_item_id AS id,
             row_number() OVER (ORDER BY me.embedding <=> ${v}::vector) AS rank,
             1 - (me.embedding <=> ${v}::vector) AS sim
      FROM baumy_memory_embeddings me
      JOIN baumy_memory_items mi ON mi.id = me.memory_item_id
      WHERE mi.group_id = ${groupId}
        AND mi.is_active = true
        AND mi.trust_level <> 'quarantined'
        AND me.model = ${EMBED_MODEL}
      ORDER BY me.embedding <=> ${v}::vector
      LIMIT ${CANDIDATES}
    ),
    lexical AS (
      SELECT mi.id AS id,
             row_number() OVER (ORDER BY ts_rank_cd(mi.content_tsv, q.tsq) DESC) AS rank
      FROM baumy_memory_items mi, q
      WHERE mi.group_id = ${groupId}
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
           mi.created_at AS "createdAt",
           f.sim AS "similarity",
           f.rrf AS "rrf"
    FROM fused f
    JOIN baumy_memory_items mi ON mi.id = f.id
    WHERE f.lex_hit = true OR f.sim >= ${floor}
    ORDER BY f.rrf DESC
    LIMIT ${CANDIDATES}
  `)

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
    createdAt: r.createdAt ? new Date(r.createdAt as string).toISOString() : undefined,
    rrf: Number(r.rrf),
  }))
}

// 0.5^(age/halflife) ∈ (0,1] — 1 for a just-written memory, → 0 for an old one.
function recencyDecay(createdAt?: string): number {
  if (!createdAt) return 0
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1
  return Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS)
}

// Blend a fusion score with a gentle recency boost (relevance dominates; recency
// only breaks near-ties toward what the house said most recently).
function compose(score: number, createdAt?: string): number {
  return score * (1 + RECENCY_WEIGHT * recencyDecay(createdAt))
}

function strip(r: ProbeRow): RetrievedMemory {
  const { rrf: _rrf, ...rest } = r
  return rest
}

// Single-probe hybrid retrieval — the original API (existing callers/tests). Now
// recency-composed before the final top-k cut.
export async function retrieve(
  query: string,
  opts: RetrieveOpts,
  deps?: RetrieveDeps,
): Promise<RetrievedMemory[]> {
  const db = deps?.db ?? createHttpDb()
  const embedFn = deps?.embed ?? embed
  const vec = await embedFn(query)
  const rows = await runHybrid(db, vec, query, opts.groupId, opts.floor ?? 0.2)
  return rows
    .map((r) => ({ r, s: compose(r.rrf, r.createdAt) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.k ?? 8)
    .map((x) => strip(x.r))
}

// Multi-probe hybrid retrieval (Phase 4). Runs one hybrid pass per probe (the query
// plus LLM-generated paraphrases / a HyDE answer), then RRF-fuses ACROSS probes by
// each item's per-probe rank, then recency-composes. A memory surfaced by several
// probes ranks higher — expansion widens recall without drowning precision.
export async function retrieveExpanded(
  query: string,
  expansions: string[],
  opts: RetrieveOpts,
  deps?: RetrieveDeps,
): Promise<RetrievedMemory[]> {
  const db = deps?.db ?? createHttpDb()
  const probes = [query, ...expansions].map((p) => p.trim()).filter(Boolean)
  if (probes.length <= 1) return retrieve(query, opts, deps)

  const floor = opts.floor ?? 0.2
  const embedManyFn = deps?.embedMany ?? (deps?.embed ? (ts: string[]) => Promise.all(ts.map(deps.embed!)) : embedMany)
  const vecs = await embedManyFn(probes)
  const lists = await Promise.all(probes.map((p, i) => runHybrid(db, vecs[i], p, opts.groupId, floor)))

  // Cross-probe RRF: sum 1/(k + rank) over the probes that surfaced each item.
  const acc = new Map<string, { row: ProbeRow; score: number }>()
  for (const list of lists) {
    list.forEach((row, rank) => {
      const cur = acc.get(row.id)
      const contrib = 1 / (RRF_K + rank)
      if (cur) {
        cur.score += contrib
        if (row.similarity > cur.row.similarity) cur.row = row // keep the strongest cosine
      } else {
        acc.set(row.id, { row, score: contrib })
      }
    })
  }

  return [...acc.values()]
    .map((e) => ({ row: e.row, s: compose(e.score, e.row.createdAt) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.k ?? 8)
    .map((x) => strip(x.row))
}
