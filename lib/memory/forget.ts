import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts, memoryItems, memoryEmbeddings } from '@/db/schema'
import { normalizeEntityName } from '@/lib/memory/facts'

// Deletion on request (owner feature). The UNIT of forgetting is a concrete VALUE STRING
// (a name, number, etc.) — resolved by the LLM, then matched EXACTLY (case-insensitive
// substring) across facts, source messages, and entity aliases. There is deliberately NO
// trigram/similarity matching: fuzzy matching both MISSED real values (note-only knowledge)
// and grabbed unrelated facts. Source messages are provenance — never deleted; a purge
// surgically scrubs just the value out of them, keeping the rest.
//
// Two modes, shown in the proposal before anything commits:
//   soft  — hide matching facts (reversible, audited); messages + aliases untouched.
//   purge — redact the fact value, scrub the value out of source messages, and drop it as
//           an entity alias, so the value is gone but its neighbours + the person survive.
export type ForgetMode = 'soft' | 'purge'
export interface ForgetFact {
  id: string
  label: string
}
export interface AliasHit {
  entityId: string
  remove: string[]
}
export interface ForgetSpec {
  /** Exact value strings the user named (verbatim). */
  values: string[]
  /** Person/thing to look a value up on (e.g. "Madeleine"), or ''. */
  subject: string
  /** Which detail to forget (e.g. "full name"), or ''. */
  attribute: string
}
export interface ForgetMatches {
  factIds: string[]
  scrubValues: string[]
  noteIds: string[]
  aliasHits: AliasHit[]
  facts: ForgetFact[]
}

const MATCH_LIMIT = 20

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

// Replace each value with "[redacted]", case-insensitively and only on WORD BOUNDARIES —
// so forgetting a short value ("Ed", "Jo") never scrubs it out of a larger word
// ("Edinburgh", "Wednesday"). The value is data, not a pattern, so it's regex-escaped;
// lookarounds (not \b) so it works even when the value's own edges aren't word chars.
export function redactValues(content: string, values: string[]): string {
  let out = content
  for (const v of values) {
    if (!v) continue
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'gi'), '[redacted]')
  }
  return out
}

// Postgres case-insensitive word-boundary regex (\y) for the SAME whole-word matching in
// SQL — so a candidate fact/message is only found when it holds the value as a whole word.
const regexEscape = (v: string) => v.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')
const wordRegex = (v: string) => `\\y${regexEscape(v)}\\y`
const labelFor = (subject: string, predicate: string, objectValue: string | null, isSecure: boolean) =>
  `${subject} ${predicate.replace(/_/g, ' ')}${isSecure ? ' (secret)' : `: ${objectValue ?? ''}`}`

// Resolve a subject description to ONE entity (exact canonical or alias, normalised). No
// fuzzy — a wrong entity would delete the wrong person's data.
async function resolveSubjectEntity(db: Database, groupId: string, subject: string): Promise<string | null> {
  const name = normalizeEntityName(subject)
  if (!name) return null
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.groupId, groupId),
        eq(entities.isActive, true),
        or(eq(entities.canonicalName, name), sql`${name} = ANY(coalesce(${entities.aliases}, '{}'::text[]))`),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

// Resolve a forget request to the EXACT facts / messages / aliases holding the value(s).
// Value strings come from (a) what the user literally named and (b) a precise subject+
// attribute lookup (e.g. subject "Madeleine" + attribute "full name" → the full_name fact's
// value). Then every store is matched by EXACT substring on those values.
export async function findMemoryToForget(db: Database, groupId: string, spec: ForgetSpec): Promise<ForgetMatches> {
  const scrub = new Set<string>()
  for (const v of spec.values) {
    const t = v.trim()
    if (t.length >= 2) scrub.add(t)
  }

  const factIds = new Set<string>()
  const factList: ForgetFact[] = []

  // Precise subject+attribute lookup: only when an attribute is given, so we never grab a
  // person's WHOLE record. All attribute words must appear in the fact (predicate+value).
  const attrWords = spec.attribute.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  if (spec.subject && attrWords.length) {
    const entId = await resolveSubjectEntity(db, groupId, spec.subject)
    if (entId) {
      const [ent] = await db.select({ name: entities.canonicalName }).from(entities).where(eq(entities.id, entId))
      const rows = await db
        .select({ id: facts.id, predicate: facts.predicate, objectValue: facts.objectValue, isSecure: facts.isSecure })
        .from(facts)
        .where(and(eq(facts.groupId, groupId), eq(facts.subjectEntityId, entId), eq(facts.isCurrent, true)))
      for (const r of rows) {
        const hay = `${r.predicate.replace(/_/g, ' ')} ${r.objectValue ?? ''}`.toLowerCase()
        if (attrWords.every((w) => hay.includes(w))) {
          factIds.add(r.id)
          factList.push({ id: r.id, label: labelFor(ent?.name ?? spec.subject, r.predicate, r.objectValue, r.isSecure) })
          if (!r.isSecure && r.objectValue && r.objectValue.trim().length >= 2) scrub.add(r.objectValue)
        }
      }
    }
  }

  const scrubValues = [...scrub]
  let noteIds: string[] = []
  const aliasHits: AliasHit[] = []

  if (scrubValues.length) {
    // Facts whose stored VALUE contains a scrub string as a WHOLE WORD (case-insensitive).
    const valueMatches = or(...scrubValues.map((v) => sql`${facts.objectValue} ~* ${wordRegex(v)}`))
    const factRows = await db
      .select({ id: facts.id, predicate: facts.predicate, objectValue: facts.objectValue, isSecure: facts.isSecure, subjectEntityId: facts.subjectEntityId })
      .from(facts)
      .where(and(eq(facts.groupId, groupId), eq(facts.isCurrent, true), valueMatches))
      .orderBy(desc(facts.recordedAt))
      .limit(MATCH_LIMIT)
    // At the cap a silent subset is forgotten while the caller reports success — make it visible.
    if (factRows.length === MATCH_LIMIT) {
      console.warn(`findMemoryToForget: fact match hit MATCH_LIMIT (${MATCH_LIMIT}); some matches may be truncated`)
    }
    // resolve subject names for labels
    const subjIds = [...new Set(factRows.map((r) => r.subjectEntityId).filter((x): x is string => !!x))]
    const names = new Map<string, string>()
    if (subjIds.length) {
      const ents = await db.select({ id: entities.id, name: entities.canonicalName }).from(entities).where(inArray(entities.id, subjIds))
      for (const e of ents) names.set(e.id, e.name)
    }
    for (const r of factRows) {
      if (factIds.has(r.id)) continue
      factIds.add(r.id)
      factList.push({ id: r.id, label: labelFor(r.subjectEntityId ? (names.get(r.subjectEntityId) ?? '') : '', r.predicate, r.objectValue, r.isSecure) })
    }

    // Source messages that literally contain a value (for surgical purge — never delete).
    const noteRows = await db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.groupId, groupId),
          eq(memoryItems.isActive, true),
          or(...scrubValues.map((v) => sql`${memoryItems.content} ~* ${wordRegex(v)}`)),
        ),
      )
    noteIds = noteRows.map((r) => r.id)

    // Entity aliases equal to a value → drop them (keep the entity + other aliases).
    const normSet = new Set(scrubValues.map((v) => normalizeEntityName(v)).filter((v) => v.length >= 2))
    const aliasRows = rowsOf(
      await db.execute(sql`
        SELECT id, aliases FROM baumy_entities
        WHERE group_id = ${groupId} AND is_active = true AND aliases IS NOT NULL AND array_length(aliases, 1) > 0`),
    )
    for (const r of aliasRows) {
      const aliases = (r.aliases as string[] | null) ?? []
      const remove = aliases.filter((a) => normSet.has(a))
      if (remove.length) aliasHits.push({ entityId: String(r.id), remove })
    }
  }

  return { factIds: [...factIds], scrubValues, noteIds, aliasHits, facts: factList }
}

// Execute a confirmed forget. Group-scoped WHERE guards make it impossible to touch
// another house's rows even with a spoofed id. Facts: soft = hide (bitemporal close +
// deleted_at); purge = also redact the value + secret. Source messages are NEVER deleted —
// purge surgically scrubs the value strings out and drops their embeddings so the re-embed
// sweep re-vectorises the redacted text. Aliases equal to a value are dropped on purge.
export async function forgetMemory(
  db: Database,
  groupId: string,
  input: { factIds: string[]; scrubValues: string[]; noteIds: string[]; aliasHits: AliasHit[]; mode: ForgetMode },
): Promise<{ facts: number; messagesScrubbed: number; aliasesRemoved: number }> {
  const now = new Date()
  let f = 0
  let messagesScrubbed = 0
  let aliasesRemoved = 0

  if (input.factIds.length) {
    const base = { isCurrent: false, deletedAt: now, invalidatedAt: now, validTo: now }
    const set = input.mode === 'purge' ? { ...base, objectValue: '[redacted on request]', objectJson: null, valueCiphertext: null, valueIv: null } : base
    const res = await db
      .update(facts)
      .set(set)
      .where(and(eq(facts.groupId, groupId), inArray(facts.id, input.factIds)))
      .returning({ id: facts.id })
    f = res.length
  }

  // Surgical message scrub (purge only) — never deletes a message.
  if (input.mode === 'purge' && input.noteIds.length && input.scrubValues.length) {
    const notes = await db
      .select({ id: memoryItems.id, content: memoryItems.content })
      .from(memoryItems)
      .where(and(eq(memoryItems.groupId, groupId), inArray(memoryItems.id, input.noteIds)))
    const scrubbedIds: string[] = []
    for (const nt of notes) {
      const redacted = redactValues(nt.content, input.scrubValues)
      if (redacted !== nt.content) {
        await db.update(memoryItems).set({ content: redacted }).where(eq(memoryItems.id, nt.id))
        scrubbedIds.push(nt.id)
      }
    }
    if (scrubbedIds.length) await db.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryItemId, scrubbedIds))
    messagesScrubbed = scrubbedIds.length
  }

  // Drop the value as an entity alias (purge only) — keeps the entity + its other aliases.
  // Independent of message scrubbing (a value can be an alias with no message holding it).
  if (input.mode === 'purge' && input.aliasHits.length) {
    for (const h of input.aliasHits) {
      const [ent] = await db.select({ aliases: entities.aliases }).from(entities).where(and(eq(entities.id, h.entityId), eq(entities.groupId, groupId)))
      if (!ent) continue
      const current = ent.aliases ?? []
      const next = current.filter((a) => !h.remove.includes(a))
      if (next.length !== current.length) {
        await db.update(entities).set({ aliases: next }).where(eq(entities.id, h.entityId))
        aliasesRemoved += current.length - next.length
      }
    }
  }

  return { facts: f, messagesScrubbed, aliasesRemoved }
}
