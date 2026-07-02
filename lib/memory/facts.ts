import { and, eq, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts } from '@/db/schema'
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
  predicate: string
  object: string
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

// Best same-kind trigram candidate for an incoming name, or null. strict_word_
// similarity aligns to word boundaries (so "sink" matches the word in "kitchen
// sink" but "rent" does not match "rest"); we take the max over both directions.
async function pickMergeCandidate(
  db: Database,
  groupId: string,
  kind: string,
  name: string,
): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT id,
           greatest(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) AS s
    FROM baumy_entities
    WHERE group_id = ${groupId} AND kind = ${kind} AND is_active = true
      AND greatest(strict_word_similarity(canonical_name, ${name}), strict_word_similarity(${name}, canonical_name)) >= ${MERGE_THRESHOLD}
    ORDER BY s DESC
    LIMIT 1`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.length ? String(rows[0].id) : null
}

// Resolve a subject surface form to a single canonical entity: exact canonical →
// exact alias → conservative same-kind trigram merge (recording the surface form as
// an alias so it resolves exactly next time) → create new.
async function resolveEntity(db: Database, groupId: string, rawName: string): Promise<string> {
  const name = normalizeEntityName(rawName)
  const kind = 'thing' // extraction is kind-agnostic today; the guard is ready for when it isn't

  const [exact] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.canonicalName, name)))
    .limit(1)
  if (exact) return exact.id

  const [aliasHit] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), sql`${name} = ANY(coalesce(${entities.aliases}, '{}'::text[]))`))
    .limit(1)
  if (aliasHit) return aliasHit.id

  const merged = await pickMergeCandidate(db, groupId, kind, name)
  if (merged) {
    // `name` is guaranteed absent from this entity's aliases (the exact-alias probe
    // above scanned every entity), so a plain append never duplicates.
    await db
      .update(entities)
      .set({ aliases: sql`array_append(coalesce(${entities.aliases}, '{}'::text[]), ${name})` })
      .where(eq(entities.id, merged))
    return merged
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
  input: { groupId: string; fact: ExtractedFact; authoredBy: string | null; trustLevel: Trust },
): Promise<ReconcileResult> {
  // Quarantined (forwarded/bot) content NEVER becomes a fact (injection wall #7).
  if (input.trustLevel === 'quarantined') return 'rejected'

  const subjectId = await resolveEntity(db, input.groupId, input.fact.subject)
  const predicate = input.fact.predicate.trim().toLowerCase()

  // Secure-value detection considers the whole triple (the secret marker usually
  // lives in the subject/predicate, e.g. "wifi password"), then encrypts the value.
  const sens = scanSensitivity(`${input.fact.subject} ${input.fact.predicate} ${input.fact.object}`)
  const isSecure = sens.isSecure
  const objectValue = isSecure ? null : input.fact.object
  const valueCiphertext = isSecure ? encryptSecret(input.fact.object) : null

  const newValues = {
    groupId: input.groupId,
    subjectEntityId: subjectId,
    predicate,
    objectValue,
    isSecure,
    valueCiphertext,
    keyVersion: isSecure ? 1 : null,
    authoredBy: input.authoredBy,
    trustLevel: input.trustLevel,
    validFrom: new Date(),
    isCurrent: true,
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
    await db.insert(facts).values(newValues)
    return 'add'
  }

  // Unchanged non-secret value → nothing to do.
  if (!isSecure && !existing.isSecure && existing.objectValue === objectValue) return 'noop'

  // Contradiction: only a fact of >= trust may overwrite the incumbent.
  if (rank(input.trustLevel) < rank(existing.trustLevel)) return 'rejected'

  const [inserted] = await db.insert(facts).values(newValues).returning({ id: facts.id })
  await db
    .update(facts)
    .set({ isCurrent: false, supersededBy: inserted.id, validTo: new Date(), invalidatedAt: new Date() })
    .where(eq(facts.id, existing.id))
  return 'update'
}

// Current facts whose subject the query refers to — a lightweight structured lookup
// the reply path unions with semantic recall. Entity resolution (Phase 3): matches
// on the canonical name OR any recorded alias (exact substring, prioritised) and
// falls back to a trigram fuzzy match, so "is the sink fixed" finds the "kitchen
// sink" entity. Secure values stay encrypted here (decrypted only in the reply).
export async function currentFactsForQuery(
  db: Database,
  groupId: string,
  query: string,
  limit = 5,
): Promise<Array<{ content: string; isSecure: boolean; contentEncrypted: string | null }>> {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const res = await db.execute(sql`
    SELECT e.canonical_name AS subject,
           f.predicate AS predicate,
           f.object_value AS "objectValue",
           f.is_secure AS "isSecure",
           f.value_ciphertext AS "valueCiphertext",
           CASE
             WHEN position(e.canonical_name IN ${q}) > 0
               OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
             THEN 0 ELSE 1
           END AS pri
    FROM baumy_facts f
    JOIN baumy_entities e ON f.subject_entity_id = e.id
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
  }))
}
