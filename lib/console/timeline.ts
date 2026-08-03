import { and, desc, eq, inArray } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { memoryItems, facts, entities, reminders } from '@/db/schema'

// The transcript view (docs/spec/sandbox-console.md). The PRIMARY OBJECT is the message: one
// inbound message fans out into evidence, facts, and the heads-ups those facts schedule. Showing
// five disconnected tables makes you correlate by timestamp in your head; grouping by the message
// is how you actually see what Baumy made of what was said.
//
// The joins already exist — facts.source_memory_item_id (the evidence note a fact came from) and
// reminders.event_fact_id (the fact a heads-up is anchored to). Three indexed reads, stitched in
// code, rather than one wide join that would multiply rows per fan-out.
//
// SECURITY: no encrypted column is selected anywhere here. memory_items.content holds only a
// non-secret descriptor and facts.object_value is NULL when is_secure, so these columns are safe to
// render precisely because they can never contain a decrypted secret. The console never decrypts.

export interface TimelineFact {
  id: string
  subject: string | null
  predicate: string
  objectValue: string | null
  isSecure: boolean
  isCurrent: boolean
  trustLevel: string
  eventAt: Date | null
  supersededBy: string | null
  reminders: { id: string; content: string; fireAt: Date; status: string }[]
}

export interface TimelineEntry {
  id: string
  content: string
  memoryType: string
  trustLevel: string
  isSecure: boolean
  authoredBy: string | null
  createdAt: Date
  facts: TimelineFact[]
}

export async function houseTimeline(db: Database, groupId: string, limit = 40): Promise<TimelineEntry[]> {
  const items = await db
    .select({
      id: memoryItems.id,
      content: memoryItems.content,
      memoryType: memoryItems.memoryType,
      trustLevel: memoryItems.trustLevel,
      isSecure: memoryItems.isSecure,
      authoredBy: memoryItems.authoredBy,
      createdAt: memoryItems.createdAt,
    })
    .from(memoryItems)
    .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.isActive, true)))
    .orderBy(desc(memoryItems.createdAt))
    .limit(limit)
  if (items.length === 0) return []

  // Facts derived from those notes — INCLUDING superseded ones, because "what Baumy concluded and
  // then changed its mind about" is the interesting part; is_current is shown, not filtered.
  const derived = await db
    .select({
      id: facts.id,
      sourceMemoryItemId: facts.sourceMemoryItemId,
      subject: entities.canonicalName,
      predicate: facts.predicate,
      objectValue: facts.objectValue, // NULL when secure — never the ciphertext
      isSecure: facts.isSecure,
      isCurrent: facts.isCurrent,
      trustLevel: facts.trustLevel,
      eventAt: facts.eventAt,
      supersededBy: facts.supersededBy,
    })
    .from(facts)
    .leftJoin(entities, eq(facts.subjectEntityId, entities.id))
    .where(
      and(
        eq(facts.groupId, groupId),
        inArray(
          facts.sourceMemoryItemId,
          items.map((i) => i.id),
        ),
      ),
    )
    .orderBy(desc(facts.recordedAt))

  const anchored = derived.length
    ? await db
        .select({ id: reminders.id, content: reminders.content, fireAt: reminders.fireAt, status: reminders.status, eventFactId: reminders.eventFactId })
        .from(reminders)
        .where(
          inArray(
            reminders.eventFactId,
            derived.map((f) => f.id),
          ),
        )
        .orderBy(reminders.fireAt)
    : []

  const byFact = new Map<string, TimelineFact['reminders']>()
  for (const r of anchored) {
    if (!r.eventFactId) continue
    byFact.set(r.eventFactId, [...(byFact.get(r.eventFactId) ?? []), { id: r.id, content: r.content, fireAt: r.fireAt, status: r.status }])
  }

  const byItem = new Map<string, TimelineFact[]>()
  for (const f of derived) {
    if (!f.sourceMemoryItemId) continue
    const entry: TimelineFact = { ...f, reminders: byFact.get(f.id) ?? [] }
    byItem.set(f.sourceMemoryItemId, [...(byItem.get(f.sourceMemoryItemId) ?? []), entry])
  }

  return items.map((i) => ({ ...i, facts: byItem.get(i.id) ?? [] }))
}

// One fact rendered as its LINEAGE rather than as a row — a fact's meaning is its history. Walks
// backward through derived_from_fact_id to the origin, then forward through superseded_by to the
// current value, so the chain reads oldest → newest regardless of which link you clicked.
export interface ChainLink {
  id: string
  subject: string | null
  predicate: string
  objectValue: string | null
  isSecure: boolean
  isCurrent: boolean
  trustLevel: string
  authoredBy: string | null
  recordedAt: Date
  eventAt: Date | null
}

const MAX_CHAIN = 50 // a cycle would be a bug, but never spin on one

export async function factChain(db: Database, groupId: string, factId: string): Promise<ChainLink[]> {
  const load = async (id: string): Promise<(ChainLink & { derivedFromFactId: string | null; supersededBy: string | null }) | null> => {
    const [row] = await db
      .select({
        id: facts.id,
        subject: entities.canonicalName,
        predicate: facts.predicate,
        objectValue: facts.objectValue,
        isSecure: facts.isSecure,
        isCurrent: facts.isCurrent,
        trustLevel: facts.trustLevel,
        authoredBy: facts.authoredBy,
        recordedAt: facts.recordedAt,
        eventAt: facts.eventAt,
        derivedFromFactId: facts.derivedFromFactId,
        supersededBy: facts.supersededBy,
      })
      .from(facts)
      .leftJoin(entities, eq(facts.subjectEntityId, entities.id))
      .where(and(eq(facts.id, id), eq(facts.groupId, groupId))) // group-scoped: never walk out of the house
      .limit(1)
    return row ?? null
  }

  const start = await load(factId)
  if (!start) return []

  const back: ChainLink[] = []
  const seen = new Set<string>([start.id])
  let cursor = start
  while (cursor.derivedFromFactId && back.length < MAX_CHAIN && !seen.has(cursor.derivedFromFactId)) {
    const prev = await load(cursor.derivedFromFactId)
    if (!prev) break
    seen.add(prev.id)
    back.unshift(prev)
    cursor = prev
  }

  const forward: ChainLink[] = []
  cursor = start
  while (cursor.supersededBy && forward.length < MAX_CHAIN && !seen.has(cursor.supersededBy)) {
    const next = await load(cursor.supersededBy)
    if (!next) break
    seen.add(next.id)
    forward.push(next)
    cursor = next
  }

  return [...back, start, ...forward]
}
