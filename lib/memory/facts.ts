import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { entities, facts, members, memoryItems } from '@/db/schema'
import { encryptSecret } from '@/lib/core/crypto'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { PROFILE_PREDICATE } from '@/lib/memory/reflect'
import { now as clockNow } from '@/lib/core/clock'
import { liveFact } from '@/lib/memory/current'
import { DEFAULT_EVENT_HOURS } from '@/lib/core/when'
import { cardinalityOf, normalizePredicate, POSSESSOR_PREDICATE } from '@/lib/memory/predicates'
import { cuedPredicates, lookupText, matchEntities, hasName, type EntityMatch, type LookupSpeaker } from '@/lib/memory/lookup'
import type { Trust } from '@/lib/core/origin'

// Trust ranking for contradiction resolution. A fact may only supersede an
// existing one when its trust is >= the incumbent's (memory-core #39). This is
// the memory-poisoning defense: pure recency-wins is the exact hole a planted
// note exploits; trust-gating closes it. Two authenticated exceptions (spec §7, F5): the SAME author
// may correct their own fact from any lane, and the owner may correct anything below 'system'.
// Anything else that contradicts a more trusted fact is kept as a non-current CONFLICT row and
// surfaced to the turn, so Baumy asks which is right instead of silently ignoring it.
const TRUST_RANK: Record<string, number> = { system: 4, trusted: 3, untrusted: 2, quarantined: 1 }
const rank = (t: string): number => TRUST_RANK[t] ?? 0

// Entity resolution (memory Phase 3). WRITE side is precision-first: a wrong merge
// permanently corrupts the graph (facts about Marta attaching to Marco), so we only
// merge on a HIGH-confidence trigram match within the same kind. READ side is
// recall-first: a false match just adds ignorable grounding, so it fuzzes generously.
const MERGE_THRESHOLD = 0.7 // strict_word_similarity (BOTH directions) to auto-merge a surface form on write
const READ_THRESHOLD = 0.6 // word_similarity to surface a fact for a query on read

export interface ExtractedFact {
  subject: string
  subjectKind?: 'person' | 'place' | 'org' | 'event' | 'thing'
  predicate: string
  object: string
  objectKind?: 'person' | 'place' | 'org' | 'event' | 'thing' | 'value'
  /** "X is no longer staying" — closes this specific value instead of adding it (spec §7, F2). */
  removes?: boolean
}
export type ReconcileResult = 'add' | 'noop' | 'update' | 'rejected' | 'conflict' | 'removed'

// Deterministic canonicalisation — the zero-risk half of de-fragmentation. Strips a
// leading article + trailing punctuation, lowercases, collapses whitespace, straightens a
// curly apostrophe, so "The Sink", "the sink" and "sink." all become one canonical name.
export function normalizeEntityName(raw: string): string {
  const n = raw
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[.,!?;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return n.length > 0 ? n : raw.trim().toLowerCase()
}

/** "charli's bike" → { owner: 'charli', head: 'bike' }; null for a plain name. */
export function possessiveParts(name: string): { owner: string; head: string } | null {
  const m = name.match(/^(.+?)'s\s+(.+)$/)
  if (!m) return null
  const owner = m[1].trim()
  // "it's", "let's", "that's" are not possessors.
  if (!owner || ['it', 'let', 'that', 'what', 'who', 'there', 'here', 'he', 'she'].includes(owner)) return null
  return { owner, head: m[2].trim() }
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

// Best trigram candidate for an incoming name (+ its kind), or null — a TYPO or inflection of the same
// name, never a different thing that shares a word (F1). So:
//   • near-equality BOTH ways (least of the two strict_word_similarity directions, not the greatest —
//     strict_word_similarity('charli', "charli's bike") is 1.0 because 'charli' is a word in it) and the
//     same number of words;
//   • a possessive ("charli's bike") or a person is never trigram-merged at all: they resolve by exact
//     name / alias (a housemate's name forms are aliases — ensureSpeakerEntity) or become a new node;
//   • the one relaxation: a single bare head noun ("the sink") resolves to the ONE existing qualified
//     node ending in it ("kitchen sink") when there is exactly one — never to a possessive one, and never
//     the other way round (a qualified phrase is never folded into its head).
// The kind guard stays lenient about 'thing' for near-equal names (a typed node absorbs a legacy
// untyped one and upgrades it).
async function pickMergeCandidate(
  db: Database,
  groupId: string,
  kind: string,
  name: string,
): Promise<{ id: string; kind: string } | null> {
  if (kind === 'person' || possessiveParts(name)) return null
  const words = name.split(' ').length
  const res = await db.execute(sql`
    SELECT id, kind, canonical_name AS name,
           least(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) AS s
    FROM baumy_entities
    WHERE group_id = ${groupId} AND is_active = true AND kind <> 'person'
      AND (kind = ${kind} OR kind = 'thing' OR ${kind} = 'thing')
      AND least(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) >= ${MERGE_THRESHOLD}
    ORDER BY s DESC
    LIMIT 5`)
  const near = rowsOf(res).find((r) => String(r.name).split(' ').length === words && !possessiveParts(String(r.name)))
  if (near) return { id: String(near.id), kind: String(near.kind) }
  if (words !== 1) return null
  const heads = rowsOf(
    await db.execute(sql`
      SELECT id, kind, canonical_name AS name
      FROM baumy_entities
      WHERE group_id = ${groupId} AND is_active = true AND kind <> 'person'
        AND (kind = ${kind} OR kind = 'thing' OR ${kind} = 'thing')
        AND right(canonical_name, ${name.length + 1}) = ${` ${name}`}
      LIMIT 3`),
  ).filter((r) => !possessiveParts(String(r.name)))
  return heads.length === 1 ? { id: String(heads[0].id), kind: String(heads[0].kind) } : null
}

// Promote a legacy untyped node to a specific kind once we learn it (person/place/…);
// never downgrades a specific kind back to 'thing'.
async function upgradeKind(db: Database, id: string, current: string, next: string): Promise<void> {
  if (current === 'thing' && next !== 'thing') {
    await db.update(entities).set({ kind: next }).where(eq(entities.id, id))
  }
}

async function activeMembers(db: Database, groupId: string): Promise<{ id: string; name: string | null }[]> {
  return db
    .select({ id: members.telegramUserId, name: members.displayName })
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.isActive, true)))
}

// The roster members whose display name (full, or first name) IS this name.
function rosterMatches(rows: { id: string; name: string | null }[], name: string) {
  return rows.filter((m) => m.name && (normalizeEntityName(m.name) === name || normalizeEntityName(m.name.split(/\s+/)[0] ?? '') === name))
}

// Bridge a resolved PERSON entity to its roster member (memory v2 §1), when the name
// UNAMBIGUOUSLY matches one active housemate's display name (full or first-name).
// Precision-first: a single match only; never overwrites an existing link.
async function linkHousemate(db: Database, groupId: string, entityId: string, name: string): Promise<void> {
  const matches = rosterMatches(await activeMembers(db, groupId), name)
  if (matches.length === 1) {
    await db
      .update(entities)
      .set({ memberId: matches[0].id })
      .where(and(eq(entities.id, entityId), isNull(entities.memberId)))
  }
}

// Resolve a subject surface form to a single canonical entity: exact canonical →
// exact alias → conservative trigram merge (recording the surface form as an alias so
// it resolves exactly next time) → create new. `kind` types the node (memory v2 §1);
// a resolved node is upgraded thing→specific when we learn what it is, and a person is
// bridged to its housemate roster row.
async function resolveEntity(db: Database, groupId: string, rawName: string, kind = 'thing'): Promise<{ id: string; kind: string }> {
  const name = normalizeEntityName(rawName)
  const resolved = await resolveEntityId(db, groupId, name, kind)
  if (resolved.kind === 'person') await linkHousemate(db, groupId, resolved.id, name)
  return resolved
}

async function findByName(db: Database, groupId: string, name: string): Promise<{ id: string; kind: string; memberId: string | null } | null> {
  const [exact] = await db
    .select({ id: entities.id, kind: entities.kind, memberId: entities.memberId })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.isActive, true), eq(entities.canonicalName, name)))
    .limit(1)
  if (exact) return exact
  const [aliasHit] = await db
    .select({ id: entities.id, kind: entities.kind, memberId: entities.memberId })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.isActive, true), sql`${name} = ANY(coalesce(${entities.aliases}, '{}'::text[]))`))
    .limit(1)
  return aliasHit ?? null
}

async function resolveEntityId(db: Database, groupId: string, name: string, kind: string): Promise<{ id: string; kind: string }> {
  const known = await findByName(db, groupId, name)
  if (known) {
    await upgradeKind(db, known.id, known.kind, kind)
    return { id: known.id, kind: known.kind === 'thing' ? kind : known.kind }
  }

  const merged = await pickMergeCandidate(db, groupId, kind, name)
  if (merged) {
    await upgradeKind(db, merged.id, merged.kind, kind)
    // `name` is guaranteed absent from this entity's aliases (the exact-alias probe
    // above scanned every entity), so a plain append never duplicates.
    await db
      .update(entities)
      .set({ aliases: sql`array_append(coalesce(${entities.aliases}, '{}'::text[]), ${name})` })
      .where(eq(entities.id, merged.id))
    return { id: merged.id, kind: merged.kind === 'thing' ? kind : merged.kind }
  }

  const [row] = await db
    .insert(entities)
    .values({ groupId, kind, canonicalName: name, createdAt: clockNow() })
    .returning({ id: entities.id })
  // A possessive node ("charli's bike") gets its owner as an EDGE, never as a merge (F1): the bike's
  // location is not Charli's, but "where's Charli's bike?" can still walk to her.
  const pos = possessiveParts(name)
  if (pos) await recordPossessor(db, groupId, row.id, pos.owner)
  return { id: row.id, kind }
}

// "charli's bike —belongs_to→ charli". Deterministic from the name, so 'system' trust and no author
// (no housemate stated it). The owner is a person when the name is a housemate's, else a thing.
async function recordPossessor(db: Database, groupId: string, possessedId: string, ownerRaw: string): Promise<void> {
  const owner = normalizeEntityName(ownerRaw)
  const isHousemate = rosterMatches(await activeMembers(db, groupId), owner).length === 1
  const o = await resolveEntity(db, groupId, owner, isHousemate ? 'person' : 'thing')
  const at = clockNow()
  await db.insert(facts).values({
    groupId,
    subjectEntityId: possessedId,
    predicate: POSSESSOR_PREDICATE,
    objectEntityId: o.id,
    objectValue: owner,
    authoredBy: null,
    trustLevel: 'system',
    validFrom: at,
    recordedAt: at,
    isCurrent: true,
  })
}

// The housemate who is speaking, as ONE person node carrying every form of their name (F6): the
// extractor files "I'm away" under the display name ("charli smith") while the house asks about
// "charli" — both must be the same entity. Linked to the roster row by member id (authenticated), the
// canonical name is the first name when no other housemate shares it, and the full + first name are
// recorded as aliases (a form another node already owns is left alone — never steal a name).
export async function ensureSpeakerEntity(db: Database, groupId: string, memberId: string, displayName: string | null): Promise<string | null> {
  const full = displayName ? normalizeEntityName(displayName) : ''
  if (!full) return null
  const first = full.split(' ')[0]
  const roster = await activeMembers(db, groupId)
  const firstShared = roster.some((m) => m.id !== memberId && m.name && normalizeEntityName(m.name.split(/\s+/)[0] ?? '') === first)

  const [linked] = await db
    .select({ id: entities.id, kind: entities.kind, memberId: entities.memberId })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.isActive, true), eq(entities.memberId, memberId)))
    .limit(1)
  const claimable = <T extends { kind: string; memberId: string | null }>(e: T | null): T | null =>
    e && (e.kind === 'person' || e.kind === 'thing') && (!e.memberId || e.memberId === memberId) ? e : null
  let ent: { id: string; kind: string } | null = linked ?? claimable(await findByName(db, groupId, full))
  if (!ent && !firstShared && first !== full) ent = claimable(await findByName(db, groupId, first))
  if (!ent) {
    const [row] = await db
      .insert(entities)
      .values({ groupId, kind: 'person', canonicalName: firstShared ? full : first, memberId, createdAt: clockNow() })
      .returning({ id: entities.id })
    ent = { id: row.id, kind: 'person' }
  } else {
    await upgradeKind(db, ent.id, ent.kind, 'person')
    await db.update(entities).set({ memberId }).where(and(eq(entities.id, ent.id), isNull(entities.memberId)))
  }

  const [cur] = await db.select({ name: entities.canonicalName, aliases: entities.aliases }).from(entities).where(eq(entities.id, ent.id))
  for (const form of firstShared ? [full] : [full, first]) {
    if (form === cur.name || (cur.aliases ?? []).includes(form)) continue
    const owner = await findByName(db, groupId, form)
    if (owner && owner.id !== ent.id) continue
    await db
      .update(entities)
      .set({ aliases: sql`array_append(coalesce(${entities.aliases}, '{}'::text[]), ${form})` })
      .where(eq(entities.id, ent.id))
  }
  return ent.id
}

// Reconcile one extracted fact into the knowledge graph: ADD (new subject+
// predicate, or another value of a multi-valued one), NOOP (unchanged), UPDATE (soft-supersede on a
// trust-permitted contradiction), REMOVED (a `removes` fact closed a value), CONFLICT (a contradiction
// the trust gate refused — kept as a non-current conflict row), or REJECTED (quarantined origin).
export interface ReconcileInput {
  groupId: string
  fact: ExtractedFact
  authoredBy: string | null
  trustLevel: Trust
  /** The author is the house owner (roster role, authenticated) — may correct any non-system fact. */
  authorIsOwner?: boolean
  neverSecret?: boolean
  memoryItemId?: string | null
  // Absolute event time, resolved by the CALLER at capture (the extractor's `when`, validated, or the
  // fallback resolver on its time phrase — lib/core/when.ts). Drives the proactive event-surfacing scan.
  eventAt?: Date | null
  // When what the fact describes is OVER (spec §6: end ?? end of day / start + 6h). Past it, the fact
  // is history, not "current" (lib/memory/current.ts, T2). Null for a timeless fact.
  validTo?: Date | null
}

/** The live fact a refused correction contradicts — what the turn tells the reply to ask about. */
export interface ConflictInfo {
  factId: string
  /** The incumbent's value; null when it is a secret (never shown). */
  object: string | null
  authoredBy: string | null
  recordedAt: Date | null
}

export interface ReconcileDetail {
  result: ReconcileResult
  /** The new current fact (add/update), the untouched incumbent (noop), the closed row (removed), the
   *  conflict row (conflict); null when rejected. */
  factId: string | null
  /** The resolved subject node — what a note about this person is tagged with (F15). */
  subjectEntityId: string | null
  subjectKind: string | null
  conflict?: ConflictInfo
}

export async function reconcileFact(db: Database, input: ReconcileInput): Promise<ReconcileResult> {
  return (await reconcileFactDetailed(db, input)).result
}

interface Incumbent {
  id: string
  objectValue: string | null
  objectEntityId: string | null
  isSecure: boolean
  trustLevel: string
  authoredBy: string | null
  eventAt: Date | null
  recordedAt: Date | null
}

// May this write close / supersede that live incumbent? (the trust gate, F5)
function mayOverride(input: ReconcileInput, existing: Incumbent): boolean {
  if (rank(input.trustLevel) >= rank(existing.trustLevel)) return true
  if (existing.trustLevel === 'system') return false
  if (input.authoredBy && existing.authoredBy && input.authoredBy === existing.authoredBy) return true
  return input.authorIsOwner === true && input.authoredBy != null
}

// reconcileFact plus WHICH row it produced: the new current fact id for add/update, the untouched
// incumbent for noop, null when rejected. The turn needs the ids of the facts THIS message wrote so
// the reply can exclude them from its own grounding (C1), the resolved subject to tag the note (F15),
// and a refused contradiction to ask about (F5).
export async function reconcileFactDetailed(db: Database, input: ReconcileInput): Promise<ReconcileDetail> {
  // Quarantined (forwarded/bot) content NEVER becomes a fact (injection wall #7).
  if (input.trustLevel === 'quarantined') return { result: 'rejected', factId: null, subjectEntityId: null, subjectKind: null }

  const subject = await resolveEntity(db, input.groupId, input.fact.subject, input.fact.subjectKind ?? 'thing')
  const subjectId = subject.id
  const detail = (result: ReconcileResult, factId: string | null, conflict?: ConflictInfo): ReconcileDetail => ({
    result,
    factId,
    subjectEntityId: subjectId,
    subjectKind: subject.kind,
    ...(conflict ? { conflict } : {}),
  })
  // The controlled vocabulary (spec §7): "arrival_date" IS "arrives_on", so a correction under the
  // synonym supersedes instead of forking a second current value (F3).
  const predicate = normalizePredicate(input.fact.predicate)

  // Secure-value detection considers the whole triple (the secret marker usually
  // lives in the subject/predicate, e.g. "wifi password"), then encrypts the value.
  // `neverSecret` opts a SYSTEM synthesis (a reflection profile) out: its material is
  // already secret-filtered upstream, so a benign paraphrase ("manages the gate code")
  // must not trip the scanner and encrypt the whole readable summary.
  const isSecure = !input.neverSecret && scanSensitivity(`${input.fact.subject} ${input.fact.predicate} ${input.fact.object}`).isSecure
  const objectValue = isSecure ? null : input.fact.object
  const valueCiphertext = isSecure ? encryptSecret(input.fact.object) : null
  // Multi-valued predicates accumulate (F2); a secret is always single-valued (one wifi password).
  const multi = !isSecure && cardinalityOf(predicate) === 'multi'

  // Relationship EDGE (memory v2 §4): when the object is a node-worthy entity (not a
  // plain 'value') and not a secret, resolve it to a real node and store the edge
  // alongside the display string. Extraction decides; default (unset/'value') → no edge.
  const objKind = input.fact.objectKind
  const objectEntityId =
    !isSecure && objKind && objKind !== 'value' ? (await resolveEntity(db, input.groupId, input.fact.object, objKind)).id : null

  const newValues = {
    groupId: input.groupId,
    subjectEntityId: subjectId,
    predicate,
    objectValue,
    objectEntityId,
    isSecure,
    valueCiphertext,
    keyVersion: isSecure ? 1 : null,
    authoredBy: input.authoredBy,
    trustLevel: input.trustLevel,
    validFrom: clockNow(),
    // For an event: when it is over (T2). Only ever set together with event_at at capture; a
    // superseded or forgotten row gets valid_to = the moment it was closed (with is_current false).
    // A caller that dates a fact without an end gets the spec default for a timed event (start + 6h),
    // so no dated fact can stay current forever.
    validTo: input.eventAt ? (input.validTo ?? new Date(input.eventAt.getTime() + DEFAULT_EVENT_HOURS * 3_600_000)) : null,
    // Explicit, not the column default: recorded_at is load-bearing (the reflect cron compares it
    // against a person's newest profile), and a Postgres defaultNow() is unreachable from a
    // simulated clock — it would silently stamp real time inside a sandbox run.
    recordedAt: clockNow(),
    isCurrent: true,
    // Provenance: the evidence note this fact was distilled from (with authoredBy = who).
    sourceMemoryItemId: input.memoryItemId ?? null,
    // Absolute event time (nullable) — the queryable anchor the event-surfacing scan reads.
    eventAt: input.eventAt ?? null,
  }

  // Compare trimmed + lowercased (the STORED value keeps its original case) so "Fixed" vs "fixed" isn't
  // misread as a contradiction that spuriously supersedes for nothing.
  const norm = (v: string | null) => normalizeEntityName(v ?? '')
  const sameValue = (r: { objectValue: string | null; objectEntityId: string | null; isSecure: boolean }) =>
    !isSecure && !r.isSecure && ((objectEntityId != null && r.objectEntityId === objectEntityId) || norm(r.objectValue) === norm(objectValue))

  // The incumbent is the LIVE fact for (subject, predicate): current and not yet over. An expired one
  // (a March visit) is history — it stays is_current (it did happen) but never blocks a new occurrence.
  // For a multi-valued predicate only the live row with the SAME value is "the" incumbent — another
  // value is a sibling, not a contradiction.
  const now = clockNow()
  const live: Incumbent[] = await db
    .select({
      id: facts.id,
      objectValue: facts.objectValue,
      objectEntityId: facts.objectEntityId,
      isSecure: facts.isSecure,
      trustLevel: facts.trustLevel,
      authoredBy: facts.authoredBy,
      eventAt: facts.eventAt,
      recordedAt: facts.recordedAt,
    })
    .from(facts)
    .where(
      and(
        eq(facts.groupId, input.groupId),
        eq(facts.subjectEntityId, subjectId),
        eq(facts.predicate, predicate),
        eq(facts.isCurrent, true),
        or(isNull(facts.validTo), gt(facts.validTo, now)),
      ),
    )
    .orderBy(desc(facts.recordedAt))
    .limit(multi ? 50 : 1)
  const existing = multi ? live.find(sameValue) : live[0]

  const conflictOf = (e: Incumbent): ConflictInfo => ({ factId: e.id, object: e.isSecure ? null : e.objectValue, authoredBy: e.authoredBy, recordedAt: e.recordedAt })
  // A contradiction the gate refused: kept, NOT current, pointing at what it contradicts — one open row
  // per (incumbent, value), so a repeat is not a second conflict.
  const storeConflict = async (e: Incumbent, removes = false): Promise<ReconcileDetail> => {
    if (!isSecure) {
      const [dup] = await db
        .select({ id: facts.id, objectValue: facts.objectValue })
        .from(facts)
        .where(and(eq(facts.conflictsWithFactId, e.id), isNull(facts.deletedAt)))
        .then((rows) => rows.filter((r) => norm(r.objectValue) === norm(objectValue)))
      if (dup) return detail('conflict', dup.id, conflictOf(e))
    }
    const [row] = await db
      .insert(facts)
      .values({ ...newValues, isCurrent: false, conflictsWithFactId: e.id, objectJson: removes ? { removes: true } : null })
      .returning({ id: facts.id })
    return detail('conflict', row.id, conflictOf(e))
  }

  // "Zuzka is no longer staying" — close that value (trust-gated like any correction). Nothing live
  // with that value → nothing to do.
  if (input.fact.removes) {
    if (!existing || !sameValue(existing)) return detail('noop', null)
    if (!mayOverride(input, existing)) return storeConflict(existing, true)
    await db.update(facts).set({ isCurrent: false, validTo: now, invalidatedAt: now }).where(eq(facts.id, existing.id))
    return detail('removed', existing.id)
  }

  const sameMoment = (a: Date | null | undefined, b: Date | null | undefined) => !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000
  const incomingEvent = input.eventAt ?? null
  // Something that is ALREADY OVER when it is said is dated in the past. What that means depends on the
  // live incumbent:
  //   • none, or a live DATED one (an upcoming / ongoing occurrence) — history: it is recorded, but it
  //     never supersedes (or re-dates) whatever is live now. "Zuzka stayed in the cave last weekend" must
  //     not close her upcoming visit, nor report her as staying now.
  //   • a live UNDATED one with a different value — a CHANGE OF STATE that happened then: "the plumber
  //     fixed the sink yesterday" over "the sink is broken", "I moved into the blue room on Monday" over
  //     the old room. It supersedes (trust-gated, below) and the new row stays live — event_at records
  //     when it changed, valid_to stays NULL (it holds until something supersedes it). Filing it as
  //     expired history left the old value grounding every answer while the ack said the new one.
  const incomingOver = newValues.validTo != null && newValues.validTo.getTime() <= now.getTime()
  const sameAsLive = !!existing && sameValue(existing)
  const stateChange = incomingOver && !!existing && !existing.eventAt && !sameAsLive
  if (stateChange) newValues.validTo = null

  if (!existing || (incomingOver && !stateChange)) {
    // The expired history of this same key (same value too, for a multi-valued one) — for the noop
    // check below and as the lineage parent of a NEW occurrence (T6: this visit follows the last one).
    const history = await db
      .select({ id: facts.id, objectValue: facts.objectValue, objectEntityId: facts.objectEntityId, isSecure: facts.isSecure, eventAt: facts.eventAt })
      .from(facts)
      .where(
        and(
          eq(facts.groupId, input.groupId),
          eq(facts.subjectEntityId, subjectId),
          eq(facts.predicate, predicate),
          eq(facts.isCurrent, true),
          isNull(facts.deletedAt),
          lte(facts.validTo, now),
        ),
      )
      .orderBy(desc(facts.eventAt))
      .limit(10)
    // A restatement of an occurrence that is already over and already on record ("Zuzka stayed in
    // Charli's room last weekend", said after the fact) is not new — same value AND same moment.
    if (incomingEvent && !isSecure) {
      const past = history.find((r) => sameValue(r) && sameMoment(r.eventAt, incomingEvent))
      if (past) return detail('noop', past.id)
    }
    // Lineage only where there is a real relation (F8): a new occurrence follows the previous one of
    // the same key. A first fact about something has no parent — it no longer borrows "the last thing
    // said about the subject", which invented "(follows from …)" stories and resurfaced forgotten facts.
    const parent = (multi ? history.find(sameValue) : history[0]) ?? null
    const [added] = await db.insert(facts).values({ ...newValues, derivedFromFactId: parent?.id ?? null }).returning({ id: facts.id })
    return detail('add', added.id)
  }

  if (sameAsLive) {
    // Unchanged value, and no new date (or the same one) → nothing to do.
    if (!incomingEvent || sameMoment(existing.eventAt, incomingEvent)) return detail('noop', existing.id)
    // The same fact finally gets its date (it was captured undated) → write the date onto it. A NEW
    // date for an already-dated live fact is a reschedule → it supersedes below, like any change (T6:
    // a repeat with a new date is never a noop that throws the date away).
    if (!existing.eventAt) {
      if (!mayOverride(input, existing)) return storeConflict(existing)
      await db.update(facts).set({ eventAt: incomingEvent, validTo: newValues.validTo }).where(eq(facts.id, existing.id))
      return detail('update', existing.id)
    }
  }

  // Contradiction: only a fact of >= trust (or the same author / the owner) may overwrite the incumbent.
  if (!mayOverride(input, existing)) return storeConflict(existing)

  // Supersede atomically-enough WITHOUT a transaction (the http driver has none): CLOSE the
  // incumbent FIRST, then insert the new current row. If the run dies between these two
  // autocommitted writes, the retry sees NO current incumbent and cleanly re-ADDs — so there
  // are never two LIVE rows (which could persistently surface a stale value). The brief
  // window where the fact has no current value self-heals on the retry.
  await db.update(facts).set({ isCurrent: false, validTo: now, invalidatedAt: now }).where(eq(facts.id, existing.id))
  // The new row DERIVES FROM the incumbent it replaces (its parent), mirroring the incumbent's
  // forward supersededBy pointer — so the supersession chain is walkable in both directions.
  const [inserted] = await db.insert(facts).values({ ...newValues, derivedFromFactId: existing.id }).returning({ id: facts.id })
  await db.update(facts).set({ supersededBy: inserted.id }).where(eq(facts.id, existing.id))
  return detail('update', inserted.id)
}

// Current dated facts in a time window — the input to the proactive event-surfacing scan
// (docs/spec/event-surfacing.md). Group-scoped, current-only, and SECRET-EXCLUDED (a heads-up
// must never surface an encrypted value — bank/door/wifi facts stay out of the group). Returns
// the subject + predicate + the resolved event_at; the scan renders the heads-up from those.
export interface DatedFact {
  id: string
  subjectEntityId: string
  subject: string
  predicate: string
  // The fact's OWN words — the model writes the heads-up from these, so a nudge reads like a
  // sentence instead of a "<subject> <predicate>" stub. Never a secret (is_secure is excluded).
  objectValue: string
  authoredBy: string | null
  eventAt: Date
  /** When the event is over (null only for a legacy row dated before valid_to was written). */
  validTo: Date | null
}

// `at` = the instant "current" is judged at (default `from`) — the scan widens `from` to the start of
// the house day, so an all-day event today (starting at local midnight) is still seen at 07:45.
export async function upcomingDatedFacts(db: Database, groupId: string, from: Date, to: Date, at: Date = from): Promise<DatedFact[]> {
  const res = await db.execute(sql`
    SELECT f.id, f.subject_entity_id AS "subjectEntityId", e.canonical_name AS subject, f.predicate,
           f.object_value AS "objectValue", f.authored_by AS "authoredBy", f.event_at AS "eventAt", f.valid_to AS "validTo"
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    WHERE f.group_id = ${groupId} AND ${liveFact('f', at)} AND f.is_secure = false
      AND f.predicate <> ${PROFILE_PREDICATE}
      AND f.event_at IS NOT NULL
      AND f.event_at >= ${from.toISOString()} AND f.event_at <= ${to.toISOString()}
    ORDER BY f.event_at ASC`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({
    id: String(r.id),
    subjectEntityId: String(r.subjectEntityId),
    subject: String(r.subject),
    predicate: String(r.predicate),
    objectValue: r.objectValue == null ? '' : String(r.objectValue),
    authoredBy: r.authoredBy == null ? null : String(r.authoredBy),
    eventAt: new Date(r.eventAt as string),
    validTo: r.validTo == null ? null : new Date(r.validTo as string),
  }))
}

// The facts of ONE event, found from the fact a heads-up reminder is anchored to: every live, non-secret,
// dated fact about the same subject on the same local day (lib/surfacing/nudge.ts groupEvents — the
// same grouping the scan used). The delivery path re-reads it so the heads-up is written from what is
// true NOW (T11): an anchor that was superseded, forgotten or is over yields [] — nothing to post.
export async function eventGroupFacts(db: Database, anchorFactId: string, tz: string, at: Date = clockNow()): Promise<DatedFact[]> {
  const res = await db.execute(sql`
    SELECT f.id, f.subject_entity_id AS "subjectEntityId", e.canonical_name AS subject, f.predicate,
           f.object_value AS "objectValue", f.authored_by AS "authoredBy", f.event_at AS "eventAt", f.valid_to AS "validTo",
           a.event_at AS "anchorAt"
    FROM baumy_facts a
    JOIN baumy_facts f ON f.group_id = a.group_id AND f.subject_entity_id = a.subject_entity_id
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    WHERE a.id = ${anchorFactId}::uuid AND ${liveFact('a', at)} AND a.is_secure = false AND a.event_at IS NOT NULL
      AND ${liveFact('f', at)} AND f.is_secure = false AND f.predicate <> ${PROFILE_PREDICATE} AND f.event_at IS NOT NULL
    ORDER BY f.event_at ASC, f.id ASC`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  const localDay = (v: unknown) => DateTime.fromJSDate(new Date(v as string)).setZone(tz).toISODate()
  return rows
    .filter((r) => localDay(r.eventAt) === localDay(r.anchorAt))
    .map((r) => ({
      id: String(r.id),
      subjectEntityId: String(r.subjectEntityId),
      subject: String(r.subject),
      predicate: String(r.predicate),
      objectValue: r.objectValue == null ? '' : String(r.objectValue),
      authoredBy: r.authoredBy == null ? null : String(r.authoredBy),
      eventAt: new Date(r.eventAt as string),
      validTo: r.validTo == null ? null : new Date(r.validTo as string),
    }))
}

// Recent CURRENT facts that carry a value but NO resolved event_at yet — the catch-up candidates
// for the end-of-day consolidation pass (docs/spec/event-surfacing.md). These are facts captured
// before event-surfacing shipped, or ones whose date the per-message extractor missed. Bounded by
// a BACKWARD recorded_at window (memory decay) so the pass stays cheap; secret-excluded. The pass
// re-parses object_value against each fact's OWN recorded_at — where "tomorrow" is unambiguous.
export interface UndatedFact {
  id: string
  objectValue: string
  recordedAt: Date
}

export async function recentUndatedFacts(db: Database, groupId: string, since: Date, now: Date = clockNow()): Promise<UndatedFact[]> {
  const res = await db.execute(sql`
    SELECT f.id, f.object_value AS "objectValue", f.recorded_at AS "recordedAt"
    FROM baumy_facts f
    WHERE f.group_id = ${groupId} AND ${liveFact('f', now)} AND f.is_secure = false
      -- NEVER a reflect PROFILE: it is a prose paragraph re-synthesised every few hours, so it is
      -- permanently "recent" and any stray month name inside it would be read as a fresh event
      -- date, forever ("Heads-up — Mad profile, today"). Profiles are not events.
      AND f.predicate <> ${PROFILE_PREDICATE}
      AND f.event_at IS NULL AND f.object_value IS NOT NULL AND length(f.object_value) > 0
      AND f.recorded_at >= ${since.toISOString()}
    ORDER BY f.recorded_at DESC
    LIMIT 500`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({ id: String(r.id), objectValue: String(r.objectValue), recordedAt: new Date(r.recordedAt as string) }))
}

// Backfill a resolved event window onto an existing CURRENT fact. A targeted single-statement UPDATE
// (neon-http has no transactions) — the fact already exists, nothing to reconcile. is_current guard
// keeps a superseded row untouched. valid_to comes with it, so the backfilled event expires too (T2).
export async function setFactEventAt(db: Database, factId: string, eventAt: Date, validTo: Date | null = null): Promise<void> {
  await db.update(facts).set({ eventAt, validTo }).where(and(eq(facts.id, factId), eq(facts.isCurrent, true)))
}


// Tag an evidence item with the PERSON it is ABOUT (memory v2 §3), so sentiment/notes
// gather under that person for their profile + reflection. Takes the entity id reconcileFact
// RESOLVED (F15) — re-looking the raw subject up by exact canonical name missed every alias-merged
// person ("charli" → the "charli smith" node). Pure linking — never a score, never volunteered;
// retrieval surfaces it only on request. Group-scoped: a note of another house is never touched.
export async function tagMemoryAboutPerson(db: Database, groupId: string, memoryItemId: string, entityId: string | null): Promise<void> {
  if (!entityId) return
  await db
    .update(memoryItems)
    .set({ aboutEntityId: entityId })
    .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.groupId, groupId)))
}

// Postgres text[] as a JS array — drivers hand it back parsed, or as the '{a,"b c"}' literal.
function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== 'string' || v.length < 2) return []
  return v
    .slice(1, -1)
    .match(/"((?:[^"\\]|\\.)*)"|[^,]+/g)
    ?.map((x) => (x.startsWith('"') ? x.slice(1, -1).replace(/\\(.)/g, '$1') : x)) ?? []
}

/** The entities a lookup text (lookup.ts lookupText) refers to, best first: named subjects, then hubs
 *  ("house"), then typo-level trigram matches (names of FUZZY_MIN_LEN+ only). */
export async function lookupEntities(db: Database, groupId: string, text: string): Promise<EntityMatch[]> {
  const res = await db.execute(sql`
    SELECT id, canonical_name AS name, aliases, kind, word_similarity(canonical_name, ${text}) AS sim
    FROM baumy_entities
    WHERE group_id = ${groupId} AND is_active = true AND length(canonical_name) > 0`)
  return matchEntities(
    rowsOf(res).map((r) => ({ id: String(r.id), name: String(r.name), aliases: textArray(r.aliases), kind: String(r.kind), similarity: Number(r.sim ?? 0) })),
    text,
    READ_THRESHOLD,
  )
}

// CURRENT (live — lib/memory/current.ts) facts the question refers to — a lightweight structured lookup
// the reply path unions with semantic recall (spec §7, F4/F7/F13). A fact is a candidate when the
// question names its SUBJECT or its OBJECT (the object node, or the value itself — "who's in the
// cave?"), when a word in it cues its predicate ("who's staying…" → has_guest / stays_in), or — for
// "what did Marco say" — when Marco said it. Names match as WHOLE WORDS ("al" is not in "at all"), and
// the ranking is by what matched: a named subject > a named object > a value > the 'house' hub > a
// cue > a typo match; the asked-about author is boosted; a reflect profile always ranks below the
// direct facts (F11). "I / my / me" are the sender (opts.speaker, from the authenticated turn).
// Secure values stay encrypted here (decrypted only in the reply).
export interface FactHit {
  id: string
  content: string
  isSecure: boolean
  contentEncrypted: string | null
  /** Member id that stated this fact (the reply layer maps it to a name for attribution). */
  authoredBy: string | null
  /** The fact this one replaced / the previous occurrence it follows (lineage parent), if non-secret
   *  and not forgotten — a short descriptor. */
  priorContent: string | null
  /** Member id that stated the lineage parent. */
  priorAuthoredBy: string | null
  /** When the fact was recorded (said) and, for a dated happening, when it happens (T1). */
  recordedAt: Date | null
  eventAt: Date | null
  /** When the event is over (valid_to) — the reply shows a multi-day range (Sat 3–Sun 4 Oct). */
  validTo: Date | null
  /** A reflect PROFILE (a synthesis, not something a housemate said) — background, shown last. */
  isProfile: boolean
}

export interface FactLookupOpts {
  /** The authenticated sender — "I / my / me" in the question resolve to them. */
  speaker?: LookupSpeaker | null
  /** "What did X say …" — X's member id (lookup.ts askedAuthor): their facts are candidates + boosted. */
  authorId?: string | null
}

const MAX_CANDIDATES = 300

// `excludeIds`: fact ids to leave out — the reply excludes the facts THIS turn just wrote (C1).
export async function currentFactsForQuery(
  db: Database,
  groupId: string,
  query: string,
  limit = 5,
  excludeIds: string[] = [],
  opts: FactLookupOpts = {},
): Promise<FactHit[]> {
  const text = lookupText(query, opts.speaker)
  if (!text.replace(/\|/g, '').trim()) return []
  const skip = new Set(excludeIds)

  const matched = await lookupEntities(db, groupId, text)
  const byId = new Map(matched.map((m) => [m.id, m]))
  const ids = matched.slice(0, 40).map((m) => sql`${m.id}::uuid`)
  const cues = cuedPredicates(text)
  const arms = [
    ids.length ? sql`f.subject_entity_id IN (${sql.join(ids, sql`, `)})` : null,
    ids.length ? sql`f.object_entity_id IN (${sql.join(ids, sql`, `)})` : null,
    cues.length ? sql`f.predicate IN (${sql.join(cues.map((c) => sql`${c}`), sql`, `)})` : null,
    // the value itself named in the question (verified as whole words below)
    sql`(f.object_value IS NOT NULL AND length(f.object_value) >= 3 AND position(lower(f.object_value) IN ${text}) > 0)`,
    opts.authorId ? sql`f.authored_by = ${opts.authorId}` : null,
  ].filter((x): x is NonNullable<typeof x> => x != null)

  // LEFT JOIN the lineage parent (derived_from_fact_id) so the reply can show the progression
  // "you said Zuzka's coming → Marco said she arrived". A secret, forgotten or conflict parent is
  // never surfaced (F8: a soft-forgotten fact must not come back as "earlier: …").
  const res = await db.execute(sql`
    SELECT f.id AS id,
           e.canonical_name AS subject,
           f.subject_entity_id AS "subjectId",
           f.object_entity_id AS "objectId",
           f.predicate AS predicate,
           f.object_value AS "objectValue",
           f.recorded_at AS "recordedAt",
           f.event_at AS "eventAt",
           f.valid_to AS "validTo",
           f.is_secure AS "isSecure",
           f.value_ciphertext AS "valueCiphertext",
           f.authored_by AS "authoredBy",
           CASE WHEN pf.id IS NOT NULL AND pf.is_secure = false
                THEN pe.canonical_name || ' ' || replace(pf.predicate, '_', ' ') || coalesce(': ' || pf.object_value, '')
                ELSE NULL END AS "priorContent",
           pf.authored_by AS "priorAuthoredBy"
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    LEFT JOIN baumy_facts pf ON f.derived_from_fact_id = pf.id AND pf.deleted_at IS NULL AND pf.conflicts_with_fact_id IS NULL
    LEFT JOIN baumy_entities pe ON pf.subject_entity_id = pe.id
    WHERE f.group_id = ${groupId} AND ${liveFact('f')} AND length(e.canonical_name) > 0
      -- the structural possessor edge ("charli's bike belongs to charli") says nothing the name doesn't
      AND NOT (f.predicate = ${POSSESSOR_PREDICATE} AND f.trust_level = 'system')
      AND (${sql.join(arms, sql` OR `)})
    ORDER BY f.recorded_at DESC
    LIMIT ${MAX_CANDIDATES}`)

  const cueBonus = (p: string) => (cues.includes(p) ? 8 : 0)
  // What matched, and how strongly. `cueOnly` (weak evidence): nothing but a predicate cue — the fallback
  // for a question that names nothing ("who's staying this weekend?") — or a subject that is only PART
  // of a longer name the question used ("charli" in "who's in charli's room?"); both are dropped as soon
  // as something IS named directly.
  const score = (r: Record<string, unknown>): { s: number; direct: boolean; cueOnly: boolean } => {
    const s = byId.get(String(r.subjectId))
    const o = r.objectId ? byId.get(String(r.objectId)) : undefined
    const p = String(r.predicate)
    const value = (r.objectValue as string | null) ?? ''
    // [base score, weak evidence only] by the strongest thing that matched
    const [first, weak] = ((): [number, boolean] => {
      if (s?.kind === 'named') return [100 + s.specificity, false]
      if (o?.kind === 'named') return [80 + o.specificity, false]
      if (value.length >= 3 && hasName(text, value)) return [75, false]
      if (s?.kind === 'hub') return [40, false]
      if (cues.includes(p)) return [35, true]
      if (s?.kind === 'fuzzy') return [30, false]
      if (s?.kind === 'part') return [28, true] // only part of a longer name that was asked
      return [o ? 25 : 0, false]
    })()
    let base = first
    let cueOnly = weak
    const direct = base >= 75
    if (base > 0) base += cueBonus(p)
    if (opts.authorId && r.authoredBy === opts.authorId) {
      base = Math.max(base, 60) + 30
      cueOnly = false
    }
    // A profile is background synthesis, never above what a housemate actually said (F11).
    if (p === PROFILE_PREDICATE && base > 0) base = Math.min(base, 20)
    return { s: base, direct, cueOnly }
  }

  const toDate = (v: unknown) => (v == null ? null : new Date(v as string))
  const scored = rowsOf(res)
    .filter((r) => !skip.has(String(r.id)))
    .map((r) => ({ r, ...score(r), at: toDate(r.recordedAt)?.getTime() ?? 0 }))
    .filter((x) => x.s > 0)
  const named = scored.some((x) => x.direct)
  const ranked = scored.filter((x) => !(named && x.cueOnly)).sort((a, b) => b.s - a.s || b.at - a.at)

  // Cap what one NON-named subject (the hub, a cue, a typo match) may contribute, so a busy "house"
  // never fills every slot; a subject the question actually names is not capped.
  const perSubject = new Map<string, number>()
  const cap = Math.max(3, Math.ceil(limit / 2))
  const out: typeof ranked = []
  for (const x of ranked) {
    if (out.length >= limit) break
    const sid = String(x.r.subjectId)
    if (byId.get(sid)?.kind !== 'named') {
      const n = perSubject.get(sid) ?? 0
      if (n >= cap) continue
      perSubject.set(sid, n + 1)
    }
    out.push(x)
  }

  return out.map(({ r }) => ({
    id: String(r.id),
    recordedAt: toDate(r.recordedAt),
    eventAt: toDate(r.eventAt),
    validTo: toDate(r.validTo),
    content: `${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}${r.isSecure ? '' : `: ${(r.objectValue as string | null) ?? ''}`}`,
    isSecure: Boolean(r.isSecure),
    contentEncrypted: (r.valueCiphertext ?? null) as string | null,
    authoredBy: (r.authoredBy ?? null) as string | null,
    priorContent: (r.priorContent ?? null) as string | null,
    priorAuthoredBy: (r.priorAuthoredBy ?? null) as string | null,
    isProfile: r.predicate === PROFILE_PREDICATE,
  }))
}
