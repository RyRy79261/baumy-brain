import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts, memoryItems, memoryEmbeddings } from '@/db/schema'
import { normalizeEntityName } from '@/lib/memory/facts'
import { normalizePredicate, predicatesCuedBy, PREDICATE_SYNONYMS, POSSESSOR_PREDICATE } from '@/lib/memory/predicates'
import { scrubWindow, withholdProducing } from '@/lib/turn/window'
import { now as clockNow } from '@/lib/core/clock'

// Deletion on request (owner feature). The UNIT of forgetting is a concrete VALUE STRING
// (a name, number, etc.) — resolved by the LLM, then matched EXACTLY (case-insensitive
// substring) across facts, source messages, and entity aliases. There is deliberately NO
// trigram/similarity matching: fuzzy matching both MISSED real values (note-only knowledge)
// and grabbed unrelated facts. Source messages are provenance — never deleted; a purge
// surgically scrubs just the value out of them, keeping the rest.
//
// Two modes, shown in the proposal before anything commits:
//   soft  — HIDE matching facts AND the messages that hold them (is_active=false — reversible,
//           audited; A7: before, the verbatim note stayed recallable, so the next question was
//           answered from the "forgotten" message); aliases untouched.
//   purge — redact the fact value, scrub the value out of source messages, and drop it as
//           an entity alias, so the value is gone but its neighbours + the person survive.
//
// Resolution (A8) is generous where the human confirm-tap is the precision gate: a named value that IS
// an entity ("forget Zosia") proposes that entity's current facts, a subject with no detail proposes
// its whole current record, and a detail is matched loosely ("where she is sleeping" → stays_in, via
// the predicate vocabulary's cue words and synonyms) — the card lists every row before anything goes.
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
  /** Person/thing to look a value up on (e.g. "Lena"), or ''. */
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

/** What the conversation window keeps of a message whose facts / notes were forgotten. */
export const FORGOTTEN_WINDOW_TEXT = '[a message about something since forgotten — withheld]'

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

// Words that say nothing about WHICH detail ("where SHE IS sleeping") — dropped before matching.
const ATTR_STOP = new Set(['she', 'her', 'hers', 'his', 'him', 'they', 'them', 'their', 'the', 'and', 'about', 'that', 'this', 'was', 'were', 'are', 'has', 'have', 'had', 'with', 'from', 'for', 'its', 'our', 'your', 'all', 'any', 'stuff', 'thing', 'things', 'info', 'detail', 'details'])

/**
 * Does a forget request's ATTRIBUTE ("where she is sleeping", "phone number") point at this fact? Loose
 * on purpose (A8): ANY meaningful word counts — a predicate the vocabulary's cue words point at
 * ("sleeping" → stays_in), a word of the predicate or of one of its synonyms ("number" ↔ phone_number →
 * phone), a word sharing a 4+ letter stem with one ("sleeps" ~ "sleeping"), or a word inside the value.
 * Before, EVERY word had to appear in "predicate value", so natural phrasing found nothing. Pure.
 */
export function attributeMatches(attribute: string, predicate: string, value: string | null): boolean {
  const words = (attribute.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !ATTR_STOP.has(w))
  if (!words.length) return false
  const pred = normalizePredicate(predicate)
  if (predicatesCuedBy(new Set(words), ` ${words.join(' ')} `).includes(pred)) return true
  const parts = new Set([pred, ...Object.entries(PREDICATE_SYNONYMS).filter(([, v]) => v === pred).map(([k]) => k)].flatMap((p) => p.split('_')).filter((p) => p.length > 2))
  const stem = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, Math.max(4, b.length - 3))) || b.startsWith(a.slice(0, Math.max(4, a.length - 3))))
  const valueWords = new Set((value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  return words.some((w) => parts.has(w) || [...parts].some((p) => stem(w, p)) || valueWords.has(w))
}

interface EntityFactRow {
  id: string
  predicate: string
  objectValue: string | null
  isSecure: boolean
  subject: string | null
  object: string | null
}

// Every CURRENT fact about one entity — as the subject, or as the object of a relationship ("chloe
// sibling_of zosia" is about Zosia too). Group-scoped; the structural possessor edge (name-derived,
// `system`) is not a detail — a housemate's stated "X belongs to Y" (or a legacy owned_by) is.
async function currentFactsOfEntity(db: Database, groupId: string, entityId: string): Promise<EntityFactRow[]> {
  return rowsOf(
    await db.execute(sql`
      SELECT f.id, f.predicate, f.object_value AS "objectValue", f.is_secure AS "isSecure",
             se.canonical_name AS subject, oe.canonical_name AS object
        FROM baumy_facts f
        LEFT JOIN baumy_entities se ON se.id = f.subject_entity_id
        LEFT JOIN baumy_entities oe ON oe.id = f.object_entity_id
       WHERE f.group_id = ${groupId} AND f.is_current = true AND NOT (f.predicate = ${POSSESSOR_PREDICATE} AND f.trust_level = 'system')
         AND (f.subject_entity_id = ${entityId} OR f.object_entity_id = ${entityId})
       ORDER BY f.recorded_at DESC
       LIMIT ${MATCH_LIMIT}`),
  ).map((r) => ({
    id: String(r.id),
    predicate: String(r.predicate),
    objectValue: (r.objectValue ?? null) as string | null,
    isSecure: Boolean(r.isSecure),
    subject: (r.subject ?? null) as string | null,
    object: (r.object ?? null) as string | null,
  }))
}

// Resolve a forget request to the EXACT facts / messages / aliases holding the value(s).
// Value strings come from (a) what the user literally named and (b) a subject+attribute lookup
// (e.g. subject "Lena" + attribute "full name" → the full_name fact's value). A named value or
// subject that IS an entity also proposes that entity's current facts (A8). Then every store is
// matched by whole-word, case-insensitive substring on the values, and the messages the proposed facts
// came from are included (a soft forget hides them too — A7).
export async function findMemoryToForget(db: Database, groupId: string, spec: ForgetSpec): Promise<ForgetMatches> {
  // What the user literally NAMED — kept apart from `scrub`, which the subject+attribute lookup below
  // widens with the matched facts' values.
  const named = spec.values.map((v) => v.trim()).filter((t) => t.length >= 2)
  const scrub = new Set<string>(named)

  const factIds = new Set<string>()
  const factList: ForgetFact[] = []
  const propose = (r: EntityFactRow) => {
    if (factIds.has(r.id)) return
    factIds.add(r.id)
    factList.push({ id: r.id, label: labelFor(r.subject ?? '', r.predicate, r.objectValue ?? r.object, r.isSecure) })
  }

  // Subject lookup. With a detail ("full name", "where she is sleeping"): the facts that detail points
  // at, and their values join the scrub list (so a purge removes them from messages too). With no detail
  // and no literal value ("forget everything about Zosia"): the subject's whole current record.
  const subjectId = spec.subject.trim() ? await resolveSubjectEntity(db, groupId, spec.subject) : null
  if (subjectId) {
    const rows = await currentFactsOfEntity(db, groupId, subjectId)
    if (spec.attribute.trim()) {
      for (const r of rows) {
        if (!attributeMatches(spec.attribute, r.predicate, r.objectValue)) continue
        propose(r)
        if (!r.isSecure && r.objectValue && r.objectValue.trim().length >= 2) scrub.add(r.objectValue)
      }
    } else if (!named.length) {
      for (const r of rows) propose(r)
    }
  }
  // A named value that is itself an entity ("forget Zosia"): its current facts, subject or object side.
  // Only the NAME is scrubbed from messages — the values of those facts are not the thing named. Only a
  // LITERALLY named value expands: "forget where Zosia is sleeping" matches stays_in = "cave", and
  // expanding that value would propose every fact about the cave (other people's too).
  for (const v of named) {
    const entId = await resolveSubjectEntity(db, groupId, v)
    if (entId) for (const r of await currentFactsOfEntity(db, groupId, entId)) propose(r)
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

  // The messages the proposed facts were extracted from (their evidence notes) — a soft forget hides
  // them too (A7), and a purge scrubs the values out of them.
  if (factIds.size) {
    const sources = await db
      .select({ id: memoryItems.id })
      .from(facts)
      .innerJoin(memoryItems, eq(memoryItems.id, facts.sourceMemoryItemId))
      .where(and(eq(facts.groupId, groupId), inArray(facts.id, [...factIds]), eq(memoryItems.groupId, groupId), eq(memoryItems.isActive, true)))
    noteIds = [...new Set([...noteIds, ...sources.map((r) => r.id)])]
  }

  return { factIds: [...factIds], scrubValues, noteIds, aliasHits, facts: factList }
}

// Execute a confirmed forget. Group-scoped WHERE guards make it impossible to touch
// another house's rows even with a spoofed id. Facts: soft = hide (bitemporal close +
// deleted_at); purge = also redact the value + secret. Source messages are NEVER deleted —
// purge surgically scrubs the value strings out and drops their embeddings so the re-embed
// sweep re-vectorises the redacted text. Aliases equal to a value are dropped on purge. Either mode
// also clears the 48h conversation window of what was forgotten.
export async function forgetMemory(
  db: Database,
  groupId: string,
  input: { factIds: string[]; scrubValues: string[]; noteIds: string[]; aliasHits: AliasHit[]; mode: ForgetMode },
): Promise<{ facts: number; messagesScrubbed: number; messagesHidden: number; aliasesRemoved: number }> {
  const now = clockNow()
  let f = 0
  let messagesScrubbed = 0
  let messagesHidden = 0
  let aliasesRemoved = 0

  // The evidence notes the forgotten facts came from — read BEFORE the facts are touched. A soft forget
  // hides them along with the matched messages (A7), so "where is Zosia staying?" can no longer be
  // answered from the verbatim "Zosia is staying in my room" note it was just told to forget. (Also
  // covers a proposal stored before its noteIds included the sources.)
  const sourceNoteIds = input.factIds.length
    ? (
        await db
          .select({ id: facts.sourceMemoryItemId })
          .from(facts)
          .where(and(eq(facts.groupId, groupId), inArray(facts.id, input.factIds)))
      ).flatMap((r) => (r.id ? [r.id] : []))
    : []
  const noteIds = [...new Set([...input.noteIds, ...sourceNoteIds])]

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

  // Soft: HIDE the messages (reversible — is_active=false, the row and its text are kept). Every
  // retrieval arm is active-only, so a hidden note never grounds a reply again.
  if (input.mode === 'soft' && noteIds.length) {
    const hidden = await db
      .update(memoryItems)
      .set({ isActive: false })
      .where(and(eq(memoryItems.groupId, groupId), inArray(memoryItems.id, noteIds), eq(memoryItems.isActive, true)))
      .returning({ id: memoryItems.id })
    messagesHidden = hidden.length
  }

  // Surgical message scrub (purge only) — never deletes a message.
  if (input.mode === 'purge' && noteIds.length && input.scrubValues.length) {
    const notes = await db
      .select({ id: memoryItems.id, content: memoryItems.content })
      .from(memoryItems)
      .where(and(eq(memoryItems.groupId, groupId), inArray(memoryItems.id, noteIds)))
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

  // The 48h conversation window (lib/turn/window.ts) holds recent chat text too, and the reply model
  // reads it as RECENT CHAT — so a forget of EITHER mode reaches it, or "is Zosia coming?" is answered
  // yes from the very line that was just forgotten. The message that produced a forgotten fact / note
  // is withheld whole (its other words may still state it); the value is scrubbed from any other line.
  // Soft vs purge is about STORED memory (reversible hide vs redaction); the window is 48h context, so
  // there is nothing to restore it for. Not counted in messagesScrubbed (that receipt is about memory).
  await withholdProducing(db, groupId, { factIds: input.factIds, memoryItemIds: noteIds }, FORGOTTEN_WINDOW_TEXT)
  if (input.scrubValues.length) await scrubWindow(db, groupId, input.scrubValues, redactValues)

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

  return { facts: f, messagesScrubbed, messagesHidden, aliasesRemoved }
}
