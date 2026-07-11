import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts, members, memoryItems } from '@/db/schema'
import { encryptSecret } from '@/lib/core/crypto'
import { scanSensitivity } from '@/lib/core/sensitivity'
import type { Trust } from '@/lib/core/origin'

// Trust ranking for contradiction resolution. A fact may only supersede an
// existing one when its trust is >= the incumbent's (memory-core #39). This is
// the memory-poisoning defense: pure recency-wins is the exact hole a planted
// note exploits; trust-gating closes it.
const TRUST_RANK: Record<string, number> = { system: 4, trusted: 3, untrusted: 2, quarantined: 1 }
const rank = (t: string): number => TRUST_RANK[t] ?? 0

// Entity resolution (memory Phase 3). WRITE side is precision-first: a wrong merge
// permanently corrupts the graph (facts about Marta attaching to Marco), so we only
// merge on a HIGH-confidence trigram match within the same kind. READ side is
// recall-first: a false match just adds ignorable grounding, so it fuzzes generously.
const MERGE_THRESHOLD = 0.7 // strict_word_similarity to auto-merge a surface form on write
const READ_THRESHOLD = 0.6 // word_similarity to surface a fact for a query on read

export interface ExtractedFact {
  subject: string
  subjectKind?: 'person' | 'place' | 'org' | 'event' | 'thing'
  predicate: string
  object: string
  objectKind?: 'person' | 'place' | 'org' | 'event' | 'thing' | 'value'
}
export type ReconcileResult = 'add' | 'noop' | 'update' | 'rejected'

// Deterministic canonicalisation — the zero-risk half of de-fragmentation. Strips a
// leading article + trailing punctuation, lowercases, collapses whitespace, so
// "The Sink", "the sink" and "sink." all become one canonical name.
export function normalizeEntityName(raw: string): string {
  const n = raw
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[.,!?;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return n.length > 0 ? n : raw.trim().toLowerCase()
}

// Best trigram candidate for an incoming name (+ its kind), or null. strict_word_
// similarity aligns to word boundaries (so "sink" matches the word in "kitchen sink"
// but "bin" does not match "bit"); we take the max over both directions. The kind
// guard is LENIENT about 'thing' — a typed 'person' still merges with a legacy
// untyped 'thing' node (and upgrades it), so typing never fragments the graph.
async function pickMergeCandidate(
  db: Database,
  groupId: string,
  kind: string,
  name: string,
): Promise<{ id: string; kind: string } | null> {
  const res = await db.execute(sql`
    SELECT id, kind,
           greatest(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) AS s
    FROM baumy_entities
    WHERE group_id = ${groupId} AND is_active = true
      AND (kind = ${kind} OR kind = 'thing' OR ${kind} = 'thing')
      AND greatest(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) >= ${MERGE_THRESHOLD}
    ORDER BY s DESC
    LIMIT 1`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.length ? { id: String(rows[0].id), kind: String(rows[0].kind) } : null
}

// Promote a legacy untyped node to a specific kind once we learn it (person/place/…);
// never downgrades a specific kind back to 'thing'.
async function upgradeKind(db: Database, id: string, current: string, next: string): Promise<void> {
  if (current === 'thing' && next !== 'thing') {
    await db.update(entities).set({ kind: next }).where(eq(entities.id, id))
  }
}

// Bridge a resolved PERSON entity to its roster member (memory v2 §1), when the name
// UNAMBIGUOUSLY matches one active housemate's display name (full or first-name).
// Precision-first: a single match only; never overwrites an existing link.
async function linkHousemate(db: Database, groupId: string, entityId: string, name: string): Promise<void> {
  const rows = await db
    .select({ id: members.telegramUserId, name: members.displayName })
    .from(members)
    .where(and(eq(members.groupId, groupId), eq(members.isActive, true)))
  const matches = rows.filter((m) => {
    if (!m.name) return false
    return normalizeEntityName(m.name) === name || normalizeEntityName(m.name.split(/\s+/)[0] ?? '') === name
  })
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
async function resolveEntity(db: Database, groupId: string, rawName: string, kind = 'thing'): Promise<string> {
  const name = normalizeEntityName(rawName)
  const entityId = await resolveEntityId(db, groupId, name, kind)
  if (kind === 'person') await linkHousemate(db, groupId, entityId, name)
  return entityId
}

async function resolveEntityId(db: Database, groupId: string, name: string, kind: string): Promise<string> {
  const [exact] = await db
    .select({ id: entities.id, kind: entities.kind })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.canonicalName, name)))
    .limit(1)
  if (exact) {
    await upgradeKind(db, exact.id, exact.kind, kind)
    return exact.id
  }

  const [aliasHit] = await db
    .select({ id: entities.id, kind: entities.kind })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), sql`${name} = ANY(coalesce(${entities.aliases}, '{}'::text[]))`))
    .limit(1)
  if (aliasHit) {
    await upgradeKind(db, aliasHit.id, aliasHit.kind, kind)
    return aliasHit.id
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
    return merged.id
  }

  const [row] = await db
    .insert(entities)
    .values({ groupId, kind, canonicalName: name })
    .returning({ id: entities.id })
  return row.id
}

// Reconcile one extracted fact into the knowledge graph: ADD (new subject+
// predicate), NOOP (unchanged), UPDATE (soft-supersede on a trust-permitted
// contradiction), or REJECTED (quarantined origin, or a lower-trust fact trying
// to overwrite a higher-trust one).
export async function reconcileFact(
  db: Database,
  input: {
    groupId: string
    fact: ExtractedFact
    authoredBy: string | null
    trustLevel: Trust
    neverSecret?: boolean
    memoryItemId?: string | null
    // Absolute event time, resolved by the CALLER from the fact's time phrase at capture (when
    // relative words like "tomorrow" are unambiguous). Drives the proactive event-surfacing scan.
    eventAt?: Date | null
  },
): Promise<ReconcileResult> {
  // Quarantined (forwarded/bot) content NEVER becomes a fact (injection wall #7).
  if (input.trustLevel === 'quarantined') return 'rejected'

  const subjectId = await resolveEntity(db, input.groupId, input.fact.subject, input.fact.subjectKind ?? 'thing')
  const predicate = input.fact.predicate.trim().toLowerCase()

  // Secure-value detection considers the whole triple (the secret marker usually
  // lives in the subject/predicate, e.g. "wifi password"), then encrypts the value.
  // `neverSecret` opts a SYSTEM synthesis (a reflection profile) out: its material is
  // already secret-filtered upstream, so a benign paraphrase ("manages the gate code")
  // must not trip the scanner and encrypt the whole readable summary.
  const isSecure = !input.neverSecret && scanSensitivity(`${input.fact.subject} ${input.fact.predicate} ${input.fact.object}`).isSecure
  const objectValue = isSecure ? null : input.fact.object
  const valueCiphertext = isSecure ? encryptSecret(input.fact.object) : null

  // Relationship EDGE (memory v2 §4): when the object is a node-worthy entity (not a
  // plain 'value') and not a secret, resolve it to a real node and store the edge
  // alongside the display string. Extraction decides; default (unset/'value') → no edge.
  const objKind = input.fact.objectKind
  const objectEntityId =
    !isSecure && objKind && objKind !== 'value'
      ? await resolveEntity(db, input.groupId, input.fact.object, objKind)
      : null

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
    validFrom: new Date(),
    isCurrent: true,
    // Provenance: the evidence note this fact was distilled from (with authoredBy = who).
    sourceMemoryItemId: input.memoryItemId ?? null,
    // Absolute event time (nullable) — the queryable anchor the event-surfacing scan reads.
    eventAt: input.eventAt ?? null,
  }

  const [existing] = await db
    .select({ id: facts.id, objectValue: facts.objectValue, isSecure: facts.isSecure, trustLevel: facts.trustLevel })
    .from(facts)
    .where(
      and(
        eq(facts.groupId, input.groupId),
        eq(facts.subjectEntityId, subjectId),
        eq(facts.predicate, predicate),
        eq(facts.isCurrent, true),
      ),
    )
    .limit(1)

  if (!existing) {
    // Lineage (no same-predicate incumbent to supersede): link this new fact to the most recent
    // thing already recorded about the SAME subject — its timeline parent. This is what chains
    // "Zuzka is coming today" → "Zuzka has arrived" even across different predicates and authors.
    // Null for the very first fact about a subject. Best-effort context, not a semantic guarantee.
    const [prior] = await db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.groupId, input.groupId), eq(facts.subjectEntityId, subjectId)))
      .orderBy(desc(facts.recordedAt))
      .limit(1)
    await db.insert(facts).values({ ...newValues, derivedFromFactId: prior?.id ?? null })
    return 'add'
  }

  // Unchanged non-secret value → nothing to do. Compare trimmed + lowercased (the STORED
  // value keeps its original case) so "Fixed" vs "fixed" isn't misread as a contradiction
  // that spuriously supersedes for nothing.
  const norm = (v: string | null) => (v ?? '').trim().toLowerCase()
  if (!isSecure && !existing.isSecure && norm(existing.objectValue) === norm(objectValue)) return 'noop'

  // Contradiction: only a fact of >= trust may overwrite the incumbent.
  if (rank(input.trustLevel) < rank(existing.trustLevel)) return 'rejected'

  // Supersede atomically-enough WITHOUT a transaction (the http driver has none): CLOSE the
  // incumbent FIRST, then insert the new current row. If the run dies between these two
  // autocommitted writes, the retry sees NO current incumbent and cleanly re-ADDs — so there
  // are never two is_current rows (which could persistently surface a stale value). The brief
  // window where the fact has no current value self-heals on the retry.
  const now = new Date()
  await db.update(facts).set({ isCurrent: false, validTo: now, invalidatedAt: now }).where(eq(facts.id, existing.id))
  // The new row DERIVES FROM the incumbent it replaces (its parent), mirroring the incumbent's
  // forward supersededBy pointer — so the supersession chain is walkable in both directions.
  const [inserted] = await db.insert(facts).values({ ...newValues, derivedFromFactId: existing.id }).returning({ id: facts.id })
  await db.update(facts).set({ supersededBy: inserted.id }).where(eq(facts.id, existing.id))
  return 'update'
}

// Current dated facts in a time window — the input to the proactive event-surfacing scan
// (docs/spec/event-surfacing.md). Group-scoped, current-only, and SECRET-EXCLUDED (a heads-up
// must never surface an encrypted value — bank/door/wifi facts stay out of the group). Returns
// the subject + predicate + the resolved event_at; the scan renders the heads-up from those.
export interface DatedFact {
  id: string
  subject: string
  predicate: string
  eventAt: Date
}

export async function upcomingDatedFacts(db: Database, groupId: string, from: Date, to: Date): Promise<DatedFact[]> {
  const res = await db.execute(sql`
    SELECT f.id, e.canonical_name AS subject, f.predicate, f.event_at AS "eventAt"
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    WHERE f.group_id = ${groupId} AND f.is_current = true AND f.is_secure = false
      AND f.event_at IS NOT NULL
      AND f.event_at >= ${from.toISOString()} AND f.event_at <= ${to.toISOString()}
    ORDER BY f.event_at ASC`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({
    id: String(r.id),
    subject: String(r.subject),
    predicate: String(r.predicate),
    eventAt: new Date(r.eventAt as string),
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

export async function recentUndatedFacts(db: Database, groupId: string, since: Date): Promise<UndatedFact[]> {
  const res = await db.execute(sql`
    SELECT f.id, f.object_value AS "objectValue", f.recorded_at AS "recordedAt"
    FROM baumy_facts f
    WHERE f.group_id = ${groupId} AND f.is_current = true AND f.is_secure = false
      AND f.event_at IS NULL AND f.object_value IS NOT NULL AND length(f.object_value) > 0
      AND f.recorded_at >= ${since.toISOString()}
    ORDER BY f.recorded_at DESC
    LIMIT 500`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({ id: String(r.id), objectValue: String(r.objectValue), recordedAt: new Date(r.recordedAt as string) }))
}

// Backfill a resolved event_at onto an existing CURRENT fact. A targeted single-statement UPDATE
// (neon-http has no transactions) — NOT reconcileFact, which NOOPs when object_value is unchanged
// and so would never write the missed date. is_current guard keeps a superseded row untouched.
export async function setFactEventAt(db: Database, factId: string, eventAt: Date): Promise<void> {
  await db.update(facts).set({ eventAt }).where(and(eq(facts.id, factId), eq(facts.isCurrent, true)))
}

// Tag an evidence item with the PERSON it is ABOUT (memory v2 §3), so sentiment/notes
// gather under that person for their profile + reflection. Uses the first person-subject
// from extraction (the entity was just resolved by reconcileFact, so it exists). This is
// pure linking — never a score, never volunteered; retrieval surfaces it only on request.
export async function tagMemoryAboutPerson(
  db: Database,
  groupId: string,
  memoryItemId: string,
  extracted: ExtractedFact[],
): Promise<void> {
  const personFact = extracted.find((f) => f.subjectKind === 'person')
  if (!personFact) return
  const canonical = normalizeEntityName(personFact.subject)
  const [ent] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.canonicalName, canonical)))
    .limit(1)
  if (ent) await db.update(memoryItems).set({ aboutEntityId: ent.id }).where(eq(memoryItems.id, memoryItemId))
}

// Current facts whose subject the query refers to — a lightweight structured lookup
// the reply path unions with semantic recall. Entity resolution (Phase 3): matches
// on the canonical name OR any recorded alias (exact substring, prioritised) and
// falls back to a trigram fuzzy match, so "is the sink fixed" finds the "kitchen
// sink" entity. Secure values stay encrypted here (decrypted only in the reply).
export interface FactHit {
  content: string
  isSecure: boolean
  contentEncrypted: string | null
  /** Member id that stated this fact (the reply layer maps it to a name for attribution). */
  authoredBy: string | null
  /** The prior fact this one follows from (lineage parent), if non-secret — a short descriptor. */
  priorContent: string | null
  /** Member id that stated the lineage parent. */
  priorAuthoredBy: string | null
}

export async function currentFactsForQuery(db: Database, groupId: string, query: string, limit = 5): Promise<FactHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []

  // LEFT JOIN the lineage parent (derived_from_fact_id) so the reply can show the progression
  // "you said Zuzka's coming → Marco said she arrived". A secret parent is never surfaced.
  const res = await db.execute(sql`
    SELECT e.canonical_name AS subject,
           f.predicate AS predicate,
           f.object_value AS "objectValue",
           f.is_secure AS "isSecure",
           f.value_ciphertext AS "valueCiphertext",
           f.authored_by AS "authoredBy",
           CASE WHEN pf.id IS NOT NULL AND pf.is_secure = false
                THEN pe.canonical_name || ' ' || replace(pf.predicate, '_', ' ') || coalesce(': ' || pf.object_value, '')
                ELSE NULL END AS "priorContent",
           pf.authored_by AS "priorAuthoredBy",
           CASE
             WHEN position(e.canonical_name IN ${q}) > 0
               OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
             THEN 0 ELSE 1
           END AS pri
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
    LEFT JOIN baumy_facts pf ON f.derived_from_fact_id = pf.id
    LEFT JOIN baumy_entities pe ON pf.subject_entity_id = pe.id
    WHERE f.group_id = ${groupId} AND f.is_current = true AND length(e.canonical_name) > 0
      AND (
        position(e.canonical_name IN ${q}) > 0
        OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
        OR word_similarity(e.canonical_name, ${q}) >= ${READ_THRESHOLD}
      )
    ORDER BY pri ASC, f.recorded_at DESC
    LIMIT ${limit}`)

  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({
    content: `${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}${r.isSecure ? '' : `: ${(r.objectValue as string | null) ?? ''}`}`,
    isSecure: Boolean(r.isSecure),
    contentEncrypted: (r.valueCiphertext ?? null) as string | null,
    authoredBy: (r.authoredBy ?? null) as string | null,
    priorContent: (r.priorContent ?? null) as string | null,
    priorAuthoredBy: (r.priorAuthoredBy ?? null) as string | null,
  }))
}
