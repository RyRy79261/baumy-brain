import { sql } from 'drizzle-orm'
import { type Database } from '@/db/client'

// Graph traversal over the facts knowledge graph — the "human-like" layer that walks
// connections BETWEEN subjects (Zuzka —sibling of→ Charl —owns→ the cave) and the full
// timeline of ONE subject (coming today → arrived → left), so a query that needs multi-hop
// knowledge ("where's Charl's sister staying?") can reach facts no single lookup would.
//
// The graph already exists in `baumy_facts`: a relationship edge is a row with
// object_entity_id set (subject —predicate→ object entity); attribute facts hang off a
// subject; derived_from/superseded_by give the temporal chain. Nothing traversed it until now.
//
// Every query here is GROUP-SCOPED, current/active, and SECRET-EXCLUDED (a secret value or a
// secret edge is never surfaced as ambient "context" — it's only ever decrypted on a direct
// answer, elsewhere). Bounded by hops + node/edge caps so a walk can never dump the whole graph.

const READ_THRESHOLD = 0.6 // word_similarity to treat a query as referring to an entity (matches facts.ts)

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export interface GraphContextItem {
  id: string
  memoryType: 'connection' | 'timeline'
  similarity: number
  content: string
  isSecure: false
  contentEncrypted: null
  authoredBy: string | null
}

// The entities a query refers to — same name/alias/trigram match the fact lookup uses, so
// "is charl's sister here" seeds on {charl}. Returns closest-matching entity ids first.
export async function resolveSeedEntities(db: Database, groupId: string, query: string, limit = 3): Promise<string[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const res = await db.execute(sql`
    SELECT e.id AS id,
           CASE
             WHEN position(e.canonical_name IN ${q}) > 0
               OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
             THEN 0 ELSE 1
           END AS pri
    FROM baumy_entities e
    WHERE e.group_id = ${groupId} AND e.is_active = true AND length(e.canonical_name) > 0
      AND (
        position(e.canonical_name IN ${q}) > 0
        OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
        OR word_similarity(e.canonical_name, ${q}) >= ${READ_THRESHOLD}
      )
    ORDER BY pri ASC
    LIMIT ${limit}`)
  return rowsOf(res).map((r) => String(r.id))
}

export interface GraphEdge {
  subject: string
  predicate: string
  object: string
  authoredBy: string | null
  depth: number
}

// Walk the relationship graph OUTWARD from the seeds (both directions along each edge), bounded
// by hops + node/edge caps, and return the edges inside that reachable neighborhood — the
// cross-subject connections. A recursive CTE finds the reachable nodes; the outer query pulls the
// edges that lie fully within them, closest-to-seed first.
export async function connectedEdges(
  db: Database,
  groupId: string,
  seedIds: string[],
  opts: { maxHops?: number; maxNodes?: number; maxEdges?: number } = {},
): Promise<GraphEdge[]> {
  if (!seedIds.length) return []
  const maxHops = opts.maxHops ?? 2
  const maxNodes = opts.maxNodes ?? 10
  const maxEdges = opts.maxEdges ?? 12
  const seedList = sql.join(
    seedIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const res = await db.execute(sql`
    WITH RECURSIVE reach(id, depth) AS (
      SELECT e.id, 0 FROM baumy_entities e WHERE e.id IN (${seedList}) AND e.group_id = ${groupId}
      UNION
      SELECT (CASE WHEN f.subject_entity_id = r.id THEN f.object_entity_id ELSE f.subject_entity_id END), r.depth + 1
      FROM reach r
      JOIN baumy_facts f
        ON f.group_id = ${groupId} AND f.is_current = true AND f.object_entity_id IS NOT NULL AND f.is_secure = false
       AND (f.subject_entity_id = r.id OR f.object_entity_id = r.id)
      WHERE r.depth < ${maxHops}
    ),
    nodes AS (SELECT id, min(depth) AS d FROM reach GROUP BY id ORDER BY d ASC LIMIT ${maxNodes})
    SELECT se.canonical_name AS subject, f.predicate AS predicate, oe.canonical_name AS object,
           f.authored_by AS "authoredBy", least(ns.d, no.d) AS depth
    FROM baumy_facts f
    JOIN nodes ns ON ns.id = f.subject_entity_id
    JOIN nodes no ON no.id = f.object_entity_id
    JOIN baumy_entities se ON se.id = f.subject_entity_id
    JOIN baumy_entities oe ON oe.id = f.object_entity_id
    WHERE f.group_id = ${groupId} AND f.is_current = true AND f.object_entity_id IS NOT NULL AND f.is_secure = false
    ORDER BY depth ASC, f.recorded_at DESC
    LIMIT ${maxEdges}`)
  return rowsOf(res).map((r) => ({
    subject: String(r.subject),
    predicate: String(r.predicate).replace(/_/g, ' '),
    object: String(r.object),
    authoredBy: (r.authoredBy ?? null) as string | null,
    depth: Number(r.depth ?? 0),
  }))
}

export interface TimelineEntry {
  content: string
  authoredBy: string | null
  isCurrent: boolean
}

// The full progression of ONE subject, oldest → newest, INCLUDING superseded rows (that's the
// story: "coming today" then "arrived"). Secret values are shown as their descriptor only,
// never the plaintext. Soft-deleted rows are excluded.
export async function entityTimeline(db: Database, groupId: string, entityId: string, limit = 8): Promise<TimelineEntry[]> {
  const res = await db.execute(sql`
    SELECT e.canonical_name AS subject, f.predicate AS predicate, f.object_value AS "objectValue",
           f.is_secure AS "isSecure", f.authored_by AS "authoredBy", f.is_current AS "isCurrent"
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    WHERE f.group_id = ${groupId} AND f.subject_entity_id = ${entityId}::uuid AND f.deleted_at IS NULL
    ORDER BY f.recorded_at ASC
    LIMIT ${limit}`)
  return rowsOf(res).map((r) => {
    const base = `${String(r.subject)} ${String(r.predicate).replace(/_/g, ' ')}`
    const content = r.isSecure ? base : `${base}: ${(r.objectValue as string | null) ?? ''}`
    return {
      content: r.isCurrent ? content : `${content} (past)`,
      authoredBy: (r.authoredBy ?? null) as string | null,
      isCurrent: Boolean(r.isCurrent),
    }
  })
}

// Assemble the connected neighborhood + the top seed's timeline into grounding items the reply
// path can reason over — the multi-hop context a flat lookup misses. Best-effort: any failure
// degrades to [] (the caller still has hybrid recall + direct facts). Deep-tier only (bounded
// cost). authoredBy stays a member id here; the caller maps it to a display name.
export async function gatherGraphContext(
  db: Database,
  groupId: string,
  query: string,
  opts: { maxHops?: number; maxNodes?: number; maxEdges?: number; timelineLimit?: number } = {},
): Promise<GraphContextItem[]> {
  const seeds = await resolveSeedEntities(db, groupId, query, 3)
  if (!seeds.length) return []
  const [edges, timeline] = await Promise.all([
    connectedEdges(db, groupId, seeds, opts),
    entityTimeline(db, groupId, seeds[0], opts.timelineLimit ?? 8),
  ])

  const items: GraphContextItem[] = []
  const seen = new Set<string>()
  const push = (memoryType: 'connection' | 'timeline', content: string, authoredBy: string | null) => {
    const key = content.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    items.push({ id: `graph:${items.length}`, memoryType, similarity: 1, content, isSecure: false, contentEncrypted: null, authoredBy })
  }
  for (const e of edges) push('connection', `${e.subject} ${e.predicate} ${e.object}`, e.authoredBy)
  // Only surface the timeline when it shows a real progression (>1 entry) — a single current
  // fact is already covered by the direct-fact lookup, so it would just be noise here.
  if (timeline.length > 1) for (const t of timeline) push('timeline', t.content, t.authoredBy)
  return items
}
