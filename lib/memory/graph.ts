import { sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { liveFact } from '@/lib/memory/current'
import { now as clockNow } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'
import { lookupEntities } from '@/lib/memory/facts'
import { lookupText, type LookupSpeaker } from '@/lib/memory/lookup'

// Graph traversal over the facts knowledge graph — the "human-like" layer that walks
// connections BETWEEN subjects (Zosia —sibling of→ Felix —owns→ the cave) and the full
// timeline of ONE subject (coming today → arrived → left), so a query that needs multi-hop
// knowledge ("where's Felix's sister staying?") can reach facts no single lookup would.
//
// The graph already exists in `baumy_facts`: a relationship edge is a row with
// object_entity_id set (subject —predicate→ object entity); attribute facts hang off a
// subject; derived_from/superseded_by give the temporal chain. Nothing traversed it until now.
//
// Every query here is GROUP-SCOPED, current/active (live: an event that is over is not a current
// connection — lib/memory/current.ts), and SECRET-EXCLUDED (a secret value or a
// secret edge is never surfaced as ambient "context" — it's only ever decrypted on a direct
// answer, elsewhere). Bounded by hops + node/edge caps so a walk can never dump the whole graph.

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
  /** The fact row behind this item + when it was recorded — the reply dates it (T1) and leaves out
   *  the facts THIS turn just wrote (C1). */
  factId?: string
  saidAt?: Date | null
}

// The entities a query refers to — the SAME whole-word / specificity matching the fact lookup uses
// (lib/memory/lookup.ts, spec §7): "is chloe's sister here" seeds on chloe (the possessive-dropped
// half of the lookup text), a named subject outranks the 'house' hub, and "my room" from Chloe is
// chloe's room. Best match first — the timeline walks seeds[0], so it must be the most specific
// named entity, not an arbitrary one (F4/F10).
export async function resolveSeedEntities(db: Database, groupId: string, query: string, limit = 3, speaker?: LookupSpeaker | null): Promise<string[]> {
  const text = lookupText(query, speaker)
  if (!text.replace(/\|/g, '').trim()) return []
  return (await lookupEntities(db, groupId, text)).slice(0, limit).map((m) => m.id)
}

export interface GraphEdge {
  factId?: string
  recordedAt?: Date | null
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
  const at = clockNow()
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
        ON f.group_id = ${groupId} AND ${liveFact('f', at)} AND f.object_entity_id IS NOT NULL AND f.is_secure = false
       AND (f.subject_entity_id = r.id OR f.object_entity_id = r.id)
      WHERE r.depth < ${maxHops}
    ),
    nodes AS (SELECT id, min(depth) AS d FROM reach GROUP BY id ORDER BY d ASC LIMIT ${maxNodes})
    SELECT f.id AS "factId", f.recorded_at AS "recordedAt",
           se.canonical_name AS subject, f.predicate AS predicate, oe.canonical_name AS object,
           f.authored_by AS "authoredBy", least(ns.d, no.d) AS depth
    FROM baumy_facts f
    JOIN nodes ns ON ns.id = f.subject_entity_id
    JOIN nodes no ON no.id = f.object_entity_id
    JOIN baumy_entities se ON se.id = f.subject_entity_id
    JOIN baumy_entities oe ON oe.id = f.object_entity_id
    WHERE f.group_id = ${groupId} AND ${liveFact('f', at)} AND f.object_entity_id IS NOT NULL AND f.is_secure = false
    ORDER BY depth ASC, f.recorded_at DESC
    LIMIT ${maxEdges}`)
  return rowsOf(res).map((r) => ({
    factId: String(r.factId),
    recordedAt: r.recordedAt ? new Date(r.recordedAt as string) : null,
    subject: String(r.subject),
    predicate: String(r.predicate).replace(/_/g, ' '),
    object: String(r.object),
    authoredBy: (r.authoredBy ?? null) as string | null,
    depth: Number(r.depth ?? 0),
  }))
}

export interface TimelineEntry {
  factId?: string
  recordedAt?: Date | null
  content: string
  authoredBy: string | null
  isCurrent: boolean
}

// The progression of ONE subject, NEWEST first (F10: it used to sort oldest-first and then LIMIT, so a
// busy subject's timeline was its first 8 facts and never "left on Sunday"), INCLUDING superseded rows
// (that's the story: "coming today" then "arrived") and events that are OVER — the one place a past
// visit still shows, as history: "(past, Sat 14 Mar)" (T2 — "when did Zosia last visit?"). Secret
// values are shown as their descriptor only, never the plaintext. Soft-deleted rows and refused
// conflict rows (never true, only disputed — F5) are excluded.
export async function entityTimeline(db: Database, groupId: string, entityId: string, limit = 8): Promise<TimelineEntry[]> {
  const at = clockNow()
  const tz = houseTz()
  const res = await db.execute(sql`
    SELECT f.id AS "factId", f.recorded_at AS "recordedAt",
           e.canonical_name AS subject, f.predicate AS predicate, f.object_value AS "objectValue",
           f.is_secure AS "isSecure", f.authored_by AS "authoredBy", f.is_current AS "isCurrent",
           f.event_at AS "eventAt", f.valid_to AS "validTo"
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    WHERE f.group_id = ${groupId} AND f.subject_entity_id = ${entityId}::uuid AND f.deleted_at IS NULL
      AND f.conflicts_with_fact_id IS NULL
    ORDER BY f.recorded_at DESC
    LIMIT ${limit}`)
  return rowsOf(res).map((r) => {
    const base = `${String(r.subject)} ${String(r.predicate).replace(/_/g, ' ')}`
    const content = r.isSecure ? base : `${base}: ${(r.objectValue as string | null) ?? ''}`
    const expired = r.isCurrent && r.validTo != null && new Date(r.validTo as string).getTime() <= at.getTime()
    const live = Boolean(r.isCurrent) && !expired
    const day = r.eventAt ? DateTime.fromJSDate(new Date(r.eventAt as string)).setZone(tz).toFormat('ccc d LLL yyyy') : null
    return {
      factId: String(r.factId),
      recordedAt: r.recordedAt ? new Date(r.recordedAt as string) : null,
      content: live ? content : `${content} (past${expired && day ? `, ${day}` : ''})`,
      authoredBy: (r.authoredBy ?? null) as string | null,
      isCurrent: live,
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
  opts: { maxHops?: number; maxNodes?: number; maxEdges?: number; timelineLimit?: number; speaker?: LookupSpeaker | null } = {},
): Promise<GraphContextItem[]> {
  const seeds = await resolveSeedEntities(db, groupId, query, 3, opts.speaker)
  if (!seeds.length) return []
  const [edges, timeline] = await Promise.all([
    connectedEdges(db, groupId, seeds, opts),
    entityTimeline(db, groupId, seeds[0], opts.timelineLimit ?? 8),
  ])

  const items: GraphContextItem[] = []
  const seen = new Set<string>()
  const push = (memoryType: 'connection' | 'timeline', content: string, authoredBy: string | null, factId?: string, saidAt?: Date | null) => {
    const key = content.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    items.push({ id: `graph:${items.length}`, memoryType, similarity: 1, content, isSecure: false, contentEncrypted: null, authoredBy, factId, saidAt })
  }
  for (const e of edges) push('connection', `${e.subject} ${e.predicate} ${e.object}`, e.authoredBy, e.factId, e.recordedAt)
  // Only surface the timeline when it shows a real progression (>1 entry) — a single current
  // fact is already covered by the direct-fact lookup, so it would just be noise here.
  if (timeline.length > 1) for (const t of timeline) push('timeline', t.content, t.authoredBy, t.factId, t.recordedAt)
  return items
}
