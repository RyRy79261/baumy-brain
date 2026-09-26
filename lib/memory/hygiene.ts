import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts, members, memoryItems } from '@/db/schema'
import { liveFact } from '@/lib/memory/current'
import { cardinalityOf, normalizePredicate } from '@/lib/memory/predicates'
import { normalizeEntityName, possessiveParts } from '@/lib/memory/facts'
import { PROFILE_PREDICATE } from '@/lib/memory/reflect'
import { writeAudit } from '@/lib/audit'
import type { MergePair } from '@/lib/ai/dedupe'

// The nightly graph-hygiene sweep (docs/spec/chat-understanding-v2.md §7, F12). Reconcile is exact-key
// and write-time only, so nothing ever repaired a split that got in before the fact model (synonym
// predicates both current, a nickname node beside the full name) or one a race let through. This does,
// deterministically where it can:
//
//   A. predicates   — rename every fact through the controlled vocabulary (lib/memory/predicates.ts);
//   B. entities     — merge nodes that are provably one: the same normalised name, one's name is the
//                     other's recorded alias, or both are linked to the same housemate;
//   C. proposals    — for look-alike THING/PLACE names (a typo, "tortila press"), ask the model; code
//                     keeps only pairs it offered and re-checks every guard. People are NEVER merged by a
//                     proposal (two people with different names are two people), nor possessives;
//   D. contradictions — a single-valued (subject, predicate) with several LIVE rows keeps one, chosen
//                     by the same trust gate reconcile applies (newest wins only if it may override;
//                     a newer row that may not becomes a conflict row); a multi-valued one drops exact
//                     duplicates of the same value;
//   E. conflicts    — a refused correction is retired (soft-deleted) once its incumbent is no longer live,
//                     or after CONFLICT_TTL_DAYS — it was asked about; it must not linger forever.
//
// Group-scoped, secret-safe (secure values are compared by nothing but identity), audited per merge.
// The model sees only names of things, never facts or people.

const CONFLICT_TTL_DAYS = 14
const PROPOSAL_MIN_SIM = 0.45 // below: not a look-alike; at/above MERGE_THRESHOLD (0.7) reconcile would have merged
const PROPOSAL_MAX_SIM = 0.7
const MAX_PROPOSALS = 10

const TRUST_RANK: Record<string, number> = { system: 4, trusted: 3, untrusted: 2, forwarded: 1, quarantined: 1 }
const rank = (t: string) => TRUST_RANK[t] ?? 0

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

export interface HygieneDeps {
  /** The LLM proposal step (lib/ai/dedupe.ts proposeEntityMerges); omitted → deterministic only. */
  proposeMerges?: (pairs: MergePair[]) => Promise<number[]>
}

export interface HygieneResult {
  renamed: number
  merged: number
  proposed: number
  resolved: number
  retired: number
}

export async function runHygieneSweep(db: Database, groupId: string, now: Date, deps: HygieneDeps = {}): Promise<HygieneResult> {
  const renamed = await canonicalisePredicates(db, groupId)
  let merged = await mergeProvenDuplicates(db, groupId)
  const { proposed, accepted } = await mergeProposals(db, groupId, deps)
  merged += accepted
  const resolved = await resolveContradictions(db, groupId, now)
  const retired = await retireConflicts(db, groupId, now)
  return { renamed, merged, proposed, resolved, retired }
}

// A — every predicate through the vocabulary (what migration 0022 did once, for rows written since).
async function canonicalisePredicates(db: Database, groupId: string): Promise<number> {
  const rows = await db.selectDistinct({ p: facts.predicate }).from(facts).where(eq(facts.groupId, groupId))
  let n = 0
  for (const { p } of rows) {
    const canonical = normalizePredicate(p)
    if (canonical === p || p === PROFILE_PREDICATE) continue
    const res = await db.update(facts).set({ predicate: canonical }).where(and(eq(facts.groupId, groupId), eq(facts.predicate, p))).returning({ id: facts.id })
    n += res.length
  }
  return n
}

interface EntityRow {
  id: string
  kind: string
  name: string
  aliases: string[]
  memberId: string | null
  createdAt: Date
}

async function activeEntities(db: Database, groupId: string): Promise<EntityRow[]> {
  const rows = await db
    .select({ id: entities.id, kind: entities.kind, name: entities.canonicalName, aliases: entities.aliases, memberId: entities.memberId, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.isActive, true)))
  return rows.map((r) => ({ ...r, aliases: r.aliases ?? [] }))
}

// Never fold two nodes linked to DIFFERENT housemates, and never mix a person with a place/org.
const compatible = (a: EntityRow, b: EntityRow) =>
  !(a.memberId && b.memberId && a.memberId !== b.memberId) && (a.kind === b.kind || a.kind === 'thing' || b.kind === 'thing')

// B — provably one node.
async function mergeProvenDuplicates(db: Database, groupId: string): Promise<number> {
  let merged = 0
  for (;;) {
    const ents = await activeEntities(db, groupId)
    const pair = findProvenPair(ents)
    if (!pair) return merged
    await mergeEntities(db, groupId, pair[0], pair[1], pair[2])
    merged++
  }
}

function findProvenPair(ents: EntityRow[]): [EntityRow, EntityRow, string] | null {
  const byName = new Map<string, EntityRow>()
  const oldestFirst = [...ents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  for (const e of oldestFirst) {
    const key = normalizeEntityName(e.name)
    const prior = byName.get(key)
    if (prior && compatible(prior, e)) return [prior, e, 'same name']
    if (!prior) byName.set(key, e)
  }
  for (const e of oldestFirst) {
    const owner = oldestFirst.find((o) => o.id !== e.id && o.aliases.includes(e.name) && compatible(o, e))
    if (owner) return [owner, e, 'name is an alias of the other']
  }
  const byMember = new Map<string, EntityRow>()
  for (const e of oldestFirst) {
    if (!e.memberId) continue
    const prior = byMember.get(e.memberId)
    if (prior) return [prior, e, 'same housemate']
    byMember.set(e.memberId, e)
  }
  return null
}

// C — look-alike things/places, judged by the model, disposed by code.
async function mergeProposals(db: Database, groupId: string, deps: HygieneDeps): Promise<{ proposed: number; accepted: number }> {
  if (!deps.proposeMerges) return { proposed: 0, accepted: 0 }
  const res = await db.execute(sql`
    SELECT a.id AS a, b.id AS b, a.canonical_name AS "aName", b.canonical_name AS "bName", a.kind AS "aKind", b.kind AS "bKind",
           least(strict_word_similarity(a.canonical_name, b.canonical_name), strict_word_similarity(b.canonical_name, a.canonical_name)) AS s
    FROM baumy_entities a
    JOIN baumy_entities b ON b.group_id = a.group_id AND a.id < b.id
    WHERE a.group_id = ${groupId} AND a.is_active AND b.is_active
      AND a.kind <> 'person' AND b.kind <> 'person' AND a.member_id IS NULL AND b.member_id IS NULL
      AND (a.kind = b.kind OR a.kind = 'thing' OR b.kind = 'thing')
      AND similarity(a.canonical_name, b.canonical_name) >= ${PROPOSAL_MIN_SIM}
    ORDER BY s DESC
    LIMIT ${MAX_PROPOSALS * 3}`)
  const candidates = rowsOf(res)
    .map((r) => ({ a: String(r.a), b: String(r.b), aName: String(r.aName), bName: String(r.bName), kind: String(r.aKind === 'thing' ? r.bKind : r.aKind), s: Number(r.s) }))
    .filter((c) => c.s >= PROPOSAL_MIN_SIM && c.s < PROPOSAL_MAX_SIM)
    .filter((c) => !possessiveParts(c.aName) && !possessiveParts(c.bName))
    // a qualified phrase and its head are two things by design ("kitchen sink" / "sink")
    .filter((c) => c.aName.split(' ').length === c.bName.split(' ').length)
    .slice(0, MAX_PROPOSALS)
  if (!candidates.length) return { proposed: 0, accepted: 0 }
  const picks = await deps.proposeMerges(candidates.map((c) => ({ a: c.aName, b: c.bName, kind: c.kind })))
  let accepted = 0
  const gone = new Set<string>()
  for (const i of new Set(picks)) {
    const c = candidates[i]
    if (!c || gone.has(c.a) || gone.has(c.b)) continue
    // Re-read both: still active, still not people, still unlinked (the guards hold at merge time).
    const both = await db
      .select({ id: entities.id, kind: entities.kind, name: entities.canonicalName, aliases: entities.aliases, memberId: entities.memberId, createdAt: entities.createdAt, isActive: entities.isActive })
      .from(entities)
      .where(and(eq(entities.groupId, groupId), inArray(entities.id, [c.a, c.b])))
    if (both.length !== 2 || both.some((e) => !e.isActive || e.kind === 'person' || e.memberId)) continue
    const [x, y] = both.map((e) => ({ ...e, aliases: e.aliases ?? [] }))
    if (!compatible(x, y)) continue
    const counts = await factCounts(db, [x.id, y.id])
    const [keep, drop] = (counts.get(x.id) ?? 0) >= (counts.get(y.id) ?? 0) ? [x, y] : [y, x]
    await mergeEntities(db, groupId, keep, drop, 'look-alike name (model-proposed, code-checked)')
    gone.add(drop.id)
    accepted++
  }
  return { proposed: candidates.length, accepted }
}

async function factCounts(db: Database, ids: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: facts.subjectEntityId, n: sql<number>`count(*)` })
    .from(facts)
    .where(inArray(facts.subjectEntityId, ids))
    .groupBy(facts.subjectEntityId)
  return new Map(rows.map((r) => [String(r.id), Number(r.n)]))
}

/** Fold `drop` into `keep`: every fact / note edge repointed, names kept as aliases, `drop` deactivated
 *  (never deleted — the audit row says what happened). */
export async function mergeEntities(db: Database, groupId: string, keep: EntityRow, drop: EntityRow, why: string): Promise<void> {
  await db.update(facts).set({ subjectEntityId: keep.id }).where(and(eq(facts.groupId, groupId), eq(facts.subjectEntityId, drop.id)))
  await db.update(facts).set({ objectEntityId: keep.id }).where(and(eq(facts.groupId, groupId), eq(facts.objectEntityId, drop.id)))
  await db.update(memoryItems).set({ aboutEntityId: keep.id }).where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.aboutEntityId, drop.id)))
  const aliases = [...new Set([...keep.aliases, drop.name, ...drop.aliases])].filter((a) => a && a !== keep.name)
  await db
    .update(entities)
    .set({
      aliases,
      memberId: keep.memberId ?? drop.memberId,
      kind: keep.kind === 'thing' ? drop.kind : keep.kind,
    })
    .where(eq(entities.id, keep.id))
  await db.update(entities).set({ isActive: false }).where(eq(entities.id, drop.id))
  await writeAudit(db, 'memory.entity_merge', null, keep.id, { groupId, kept: keep.name, dropped: drop.name, droppedId: drop.id, why })
}

interface LiveRow {
  id: string
  subject: string
  predicate: string
  objectValue: string | null
  isSecure: boolean
  trustLevel: string
  authoredBy: string | null
  recordedAt: Date
  derivedFromFactId: string | null
}

// D — one live value per single-valued (subject, predicate); no duplicate values in a multi-valued one.
async function resolveContradictions(db: Database, groupId: string, now: Date): Promise<number> {
  const res = await db.execute(sql`
    SELECT f.id, f.subject_entity_id AS subject, f.predicate, f.object_value AS "objectValue", f.is_secure AS "isSecure",
           f.trust_level AS "trustLevel", f.authored_by AS "authoredBy", f.recorded_at AS "recordedAt", f.derived_from_fact_id AS "derivedFromFactId"
    FROM baumy_facts f
    WHERE f.group_id = ${groupId} AND ${liveFact('f', now)} AND f.subject_entity_id IS NOT NULL
      AND (f.subject_entity_id, f.predicate) IN (
        SELECT g.subject_entity_id, g.predicate FROM baumy_facts g
        WHERE g.group_id = ${groupId} AND ${liveFact('g', now)} AND g.subject_entity_id IS NOT NULL
        GROUP BY g.subject_entity_id, g.predicate HAVING count(*) > 1)
    ORDER BY f.recorded_at ASC, f.id ASC`)
  const rows: LiveRow[] = rowsOf(res).map((r) => ({
    id: String(r.id),
    subject: String(r.subject),
    predicate: String(r.predicate),
    objectValue: (r.objectValue ?? null) as string | null,
    isSecure: Boolean(r.isSecure),
    trustLevel: String(r.trustLevel),
    authoredBy: (r.authoredBy ?? null) as string | null,
    recordedAt: new Date(r.recordedAt as string),
    derivedFromFactId: (r.derivedFromFactId ?? null) as string | null,
  }))
  if (!rows.length) return 0
  const owners = new Set(
    (await db.select({ id: members.telegramUserId }).from(members).where(and(eq(members.groupId, groupId), eq(members.role, 'owner'), eq(members.isActive, true)))).map((m) => m.id),
  )
  const groups = new Map<string, LiveRow[]>()
  for (const r of rows) {
    const k = `${r.subject}|${r.predicate}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const norm = (v: string | null) => normalizeEntityName(v ?? '')
  let resolved = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    if (cardinalityOf(group[0].predicate) === 'multi' && !group.some((r) => r.isSecure)) {
      // Exact duplicate values (a race, or two synonyms renamed onto one): keep the newest of each.
      const byValue = new Map<string, LiveRow[]>()
      for (const r of group) byValue.set(norm(r.objectValue), [...(byValue.get(norm(r.objectValue)) ?? []), r])
      for (const same of byValue.values()) {
        const winner = same[same.length - 1]
        for (const loser of same.slice(0, -1)) resolved += await supersede(db, loser, winner, now)
      }
      continue
    }
    // Replay the rows in the order they were said, through the trust gate.
    let winner = group[0]
    for (const next of group.slice(1)) {
      const may =
        rank(next.trustLevel) >= rank(winner.trustLevel) ||
        (winner.trustLevel !== 'system' && next.authoredBy != null && (next.authoredBy === winner.authoredBy || owners.has(next.authoredBy)))
      if (may) {
        resolved += await supersede(db, winner, next, now)
        winner = next
      } else {
        await db.update(facts).set({ isCurrent: false, conflictsWithFactId: winner.id }).where(eq(facts.id, next.id))
        resolved++
      }
    }
  }
  return resolved
}

async function supersede(db: Database, loser: LiveRow, winner: LiveRow, now: Date): Promise<number> {
  await db.update(facts).set({ isCurrent: false, validTo: now, invalidatedAt: now, supersededBy: winner.id }).where(eq(facts.id, loser.id))
  if (!winner.derivedFromFactId) {
    await db.update(facts).set({ derivedFromFactId: loser.id }).where(and(eq(facts.id, winner.id), isNull(facts.derivedFromFactId)))
    winner.derivedFromFactId = loser.id
  }
  return 1
}

// E — a refused correction does not linger: retired once what it contradicted is no longer live, or
// after the TTL. Soft (deleted_at), like a forget.
async function retireConflicts(db: Database, groupId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CONFLICT_TTL_DAYS * 86_400_000)
  const res = await db.execute(sql`
    UPDATE baumy_facts c SET deleted_at = ${now.toISOString()}
    WHERE c.group_id = ${groupId} AND c.conflicts_with_fact_id IS NOT NULL AND c.deleted_at IS NULL
      AND (
        c.recorded_at < ${cutoff.toISOString()}
        OR NOT EXISTS (SELECT 1 FROM baumy_facts i WHERE i.id = c.conflicts_with_fact_id AND ${liveFact('i', now)})
      )
    RETURNING c.id`)
  return rowsOf(res).length
}
