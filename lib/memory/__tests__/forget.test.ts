import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities, memoryItems } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { findMemoryToForget, forgetMemory, redactValues } from '@/lib/memory/forget'
import { embedSync } from '@/lib/ai/embed'

const GROUP = '-100forget'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64')
const embed = async (t: string) => embedSync(t)
const person = (subject: string, predicate: string, object: string) => ({ subject, subjectKind: 'person' as const, predicate, object })
const run = (db: Awaited<ReturnType<typeof makeTestDb>>, m: Awaited<ReturnType<typeof findMemoryToForget>>, mode: 'soft' | 'purge') =>
  forgetMemory(db, GROUP, { factIds: m.factIds, scrubValues: m.scrubValues, noteIds: m.noteIds, aliasHits: m.aliasHits, mode })

describe('deletion on request (forget) — exact value matching', () => {
  it('redactValues scrubs case-insensitively and keeps the surrounding text', () => {
    expect(redactValues("I'm Ryan, and madeleine goujon lives here", ['Madeleine Goujon'])).toBe("I'm Ryan, and [redacted] lives here")
  })

  it('redactValues matches WHOLE WORDS only — a short value never mangles a larger word', () => {
    expect(redactValues('I love Edinburgh, thanks Ed', ['Ed'])).toBe('I love Edinburgh, thanks [redacted]')
    expect(redactValues('bins on wednesday, ask Jo', ['Jo'])).toBe('bins on wednesday, ask [redacted]')
  })

  it('a short value does not drag in messages that merely contain it as a substring', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await captureMemory({ groupId: GROUP, content: 'we all went to Edinburgh last year', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    const m = await findMemoryToForget(db, GROUP, { values: ['Ed'], subject: '', attribute: '' })
    expect(m.noteIds).toHaveLength(0) // "Edinburgh" is not a match for the whole word "Ed"
  })

  // BUG 1 (the "nothing to forget" report): the value lives only in a raw message, no fact.
  it('finds a value that exists ONLY in a message (no fact needed) and scrubs it surgically', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const noteId = await captureMemory(
      { groupId: GROUP, content: "I'm Ryan, and Madeleine is Madeleine Goujon, she takes front room 2", memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' },
      { db, embed },
    )
    const m = await findMemoryToForget(db, GROUP, { values: ['Madeleine Goujon'], subject: '', attribute: '' })
    expect(m.scrubValues).toEqual(['Madeleine Goujon'])
    expect(m.noteIds).toContain(noteId) // found by exact substring, no fact required

    const res = await run(db, m, 'purge')
    expect(res.messagesScrubbed).toBe(1)
    const [note] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.c).not.toContain('Madeleine Goujon')
    expect(note.c).toContain('Ryan') // the rest of the message survives
    expect(note.c).toContain('front room 2')
  })

  // BUG 2 (the "grabbing unrelated facts" report): a value that isn't stored matches NOTHING.
  it('never grabs unrelated facts — exact matching, no fuzzy similarity', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('ryan', 'reminder_for', 'roztoc festival tickets'), authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'house', predicate: 'mother_staying', object: 'no' }, authoredBy: null, trustLevel: 'untrusted' })
    await captureMemory({ groupId: GROUP, content: 'add feature request and issue tracking via github', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, { values: ['Madeleine Goujon'], subject: '', attribute: '' })
    expect(m.facts).toHaveLength(0) // NONE of the roztoc/github/mother rows are dragged in
    expect(m.noteIds).toHaveLength(0)
  })

  it('resolves subject + attribute to the ONE exact fact value (not the whole person)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('madeleine', 'full_name', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: person('madeleine', 'room', 'front room 2'), authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Madeleine Goujon has front room 2', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Madeleine', attribute: 'full name' })
    expect(m.facts).toHaveLength(1) // ONLY the full_name fact
    expect(m.facts[0].label).toContain('Madeleine Goujon')
    expect(m.scrubValues).toContain('Madeleine Goujon')
    expect(m.noteIds).toContain(noteId)
    expect(m.facts.some((f) => f.label.includes('front room 2'))).toBe(false) // the room is NOT targeted
  })

  it('PURGE scrubs only the value from a multi-person message, keeping the rest', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const intro = "I'm Ryan Noble, Charl is Charl Jacobs, and Madeleine is Madeleine Goujon"
    const noteId = await captureMemory({ groupId: GROUP, content: intro, memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await reconcileFact(db, { groupId: GROUP, fact: person('madeleine', 'full_name', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })

    const m = await findMemoryToForget(db, GROUP, { values: ['Madeleine Goujon'], subject: '', attribute: '' })
    await run(db, m, 'purge')
    const [note] = await db.select({ c: memoryItems.content, a: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.a).toBe(true)
    expect(note.c).not.toContain('Madeleine Goujon')
    expect(note.c).toContain('Ryan Noble')
    expect(note.c).toContain('Charl Jacobs')
  })

  it('drops the value as an entity alias but keeps the entity + other aliases', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('madeleine', 'full_name', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })
    const [ent] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'madeleine')))
    await db.update(entities).set({ aliases: ['madeleine goujon', 'mad'] }).where(eq(entities.id, ent.id))

    const m = await findMemoryToForget(db, GROUP, { values: ['Madeleine Goujon'], subject: '', attribute: '' })
    expect(m.aliasHits.some((h) => h.remove.includes('madeleine goujon'))).toBe(true)
    const res = await run(db, m, 'purge')
    expect(res.aliasesRemoved).toBe(1)
    const [after] = await db.select({ aliases: entities.aliases }).from(entities).where(eq(entities.id, ent.id))
    expect(after.aliases).toContain('mad') // the permitted alias stays
    expect(after.aliases).not.toContain('madeleine goujon')
  })

  it('SOFT hides facts but leaves messages + aliases untouched (reversible)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('madeleine', 'full_name', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Madeleine is Madeleine Goujon btw', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, { values: ['Madeleine Goujon'], subject: '', attribute: '' })
    const res = await run(db, m, 'soft')
    expect(res.messagesScrubbed).toBe(0)
    expect(res.aliasesRemoved).toBe(0)
    expect(res.facts).toBe(1)
    expect(await currentFactsForQuery(db, GROUP, 'madeleine full name')).toHaveLength(0) // fact hidden
    const [note] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.c).toContain('Madeleine Goujon') // message intact
  })

  it('NEVER touches another house’s rows (group-scoped)', async () => {
    const db = await makeTestDb()
    const OTHER = '-100other'
    await ensureRegistered(db, GROUP, null)
    await ensureRegistered(db, OTHER, null)
    const otherNote = await captureMemory({ groupId: OTHER, content: 'Madeleine Goujon in the other house', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    // scoped to GROUP but handed OTHER's ids → no-op
    const res = await forgetMemory(db, GROUP, { factIds: [], scrubValues: ['Madeleine Goujon'], noteIds: [otherNote], aliasHits: [], mode: 'purge' })
    expect(res.messagesScrubbed).toBe(0)
    const [n] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, otherNote))
    expect(n.c).toContain('Madeleine Goujon')
  })
})

// Phase 5 (spec §8): a soft forget HIDES the source message too (A7); subject / attribute resolution
// finds what a person naturally names (A8). The confirm tap is the precision gate, so resolution may
// be generous — the card lists every row before anything goes.
describe('forget — A7 soft hides the source note, A8 subject/attribute matching', () => {
  async function seed() {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const noteId = await captureMemory({ groupId: GROUP, content: 'Zuzka is staying in my room this weekend', memoryType: 'statement', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await reconcileFact(db, { groupId: GROUP, fact: { ...person('zuzka', 'stays_in', "charli's room"), objectKind: 'value' }, authoredBy: null, trustLevel: 'untrusted', memoryItemId: noteId })
    return { db, noteId }
  }

  it('attributeMatches is loose on purpose: cue words, predicate/synonym words, shared stems, the value', async () => {
    const { attributeMatches } = await import('@/lib/memory/forget')
    expect(attributeMatches('where she is sleeping', 'stays_in', "charli's room")).toBe(true) // cue "sleeping"
    expect(attributeMatches('phone number', 'phone', '0176')).toBe(true)
    expect(attributeMatches('the room', 'stays_in', "charli's room")).toBe(true) // a word of the value
    expect(attributeMatches('birthday', 'stays_in', "charli's room")).toBe(false)
    expect(attributeMatches('she is', 'stays_in', "charli's room")).toBe(false) // only filler → nothing
  })

  it('"forget Zuzka" (the value IS the subject) proposes her facts, not just notes', async () => {
    const { db, noteId } = await seed()
    const m = await findMemoryToForget(db, GROUP, { values: ['Zuzka'], subject: 'Zuzka', attribute: '' })
    expect(m.facts.map((f) => f.label)).toEqual(["zuzka stays in: charli's room"])
    expect(m.noteIds).toEqual([noteId])
  })

  it('subject + natural attribute ("where she is sleeping") finds stays_in', async () => {
    const { db } = await seed()
    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Zuzka', attribute: 'where she is sleeping' })
    expect(m.facts).toHaveLength(1)
    expect(m.scrubValues).toEqual(["charli's room"])
  })

  it('subject + attribute proposes ONLY the matched facts — the matched value (an entity) is not expanded', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { ...person('zuzka', 'stays_in', 'cave'), objectKind: 'place' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'cave', subjectKind: 'place', predicate: 'status', object: 'damp' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'cave', subjectKind: 'place', predicate: 'location', object: 'downstairs' }, authoredBy: null, trustLevel: 'untrusted' })
    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Zuzka', attribute: 'where she is sleeping' })
    expect(m.facts.map((f) => f.label)).toEqual(['zuzka stays in: cave'])
    // …while literally NAMING the entity still proposes its record.
    const named = await findMemoryToForget(db, GROUP, { values: ['cave'], subject: '', attribute: '' })
    expect(named.facts.map((f) => f.label).sort()).toEqual(['cave location: downstairs', 'cave status: damp', 'zuzka stays in: cave'])
  })

  it('a STATED ownership fact (belongs_to / legacy owned_by) is a forgettable detail; the structural edge is not', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    // "charli's bike" mints the structural edge (belongs_to charli, system); the ladder's owner is stated.
    await reconcileFact(db, { groupId: GROUP, fact: { subject: "charli's bike", predicate: 'location', object: 'the shed' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'the ladder', predicate: 'owned_by', object: 'marco' }, authoredBy: null, trustLevel: 'untrusted' })
    const ladder = await findMemoryToForget(db, GROUP, { values: [], subject: 'the ladder', attribute: 'the owner' })
    expect(ladder.facts.map((f) => f.label)).toEqual(['ladder belongs to: marco'])
    const bike = await findMemoryToForget(db, GROUP, { values: [], subject: "charli's bike", attribute: '' })
    expect(bike.facts.map((f) => f.label)).toEqual(["charli's bike location: the shed"])
  })

  it('a subject with no detail and no value → the whole current record', async () => {
    const { db } = await seed()
    await reconcileFact(db, { groupId: GROUP, fact: person('zuzka', 'arrives_on', 'friday'), authoredBy: null, trustLevel: 'untrusted' })
    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Zuzka', attribute: '' })
    expect(m.facts).toHaveLength(2)
  })

  it('a SOFT forget hides the fact AND its source note, so retrieval no longer returns it (reversible: the row stays)', async () => {
    const { db, noteId } = await seed()
    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Zuzka', attribute: 'where she is sleeping' })
    const res = await run(db, m, 'soft')
    expect(res).toMatchObject({ facts: 1, messagesHidden: 1, messagesScrubbed: 0 })
    const [note] = await db.select({ active: memoryItems.isActive, c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note).toEqual({ active: false, c: 'Zuzka is staying in my room this weekend' }) // hidden, not rewritten
    const { retrieve } = await import('@/lib/memory/retrieve')
    expect(await retrieve('where is Zuzka staying this weekend', { groupId: GROUP, k: 8, floor: 0.05 }, { db, embed })).toEqual([])
    expect(await currentFactsForQuery(db, GROUP, 'where is zuzka staying?')).toEqual([])
  })

  it('a soft forget also hides the source note of a fact proposed before noteIds carried it', async () => {
    const { db, noteId } = await seed()
    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Zuzka', attribute: 'sleeping' })
    await forgetMemory(db, GROUP, { factIds: m.factIds, scrubValues: [], noteIds: [], aliasHits: [], mode: 'soft' })
    const [note] = await db.select({ active: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.active).toBe(false)
  })
})
