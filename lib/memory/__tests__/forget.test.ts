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
    expect(redactValues("I'm Ryan, and lena okafor lives here", ['Lena Okafor'])).toBe("I'm Ryan, and [redacted] lives here")
  })

  // BUG 1 (the "nothing to forget" report): the value lives only in a raw message, no fact.
  it('finds a value that exists ONLY in a message (no fact needed) and scrubs it surgically', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const noteId = await captureMemory(
      { groupId: GROUP, content: "I'm Ryan, and Lena is Lena Okafor, she takes front room 2", memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' },
      { db, embed },
    )
    const m = await findMemoryToForget(db, GROUP, { values: ['Lena Okafor'], subject: '', attribute: '' })
    expect(m.scrubValues).toEqual(['Lena Okafor'])
    expect(m.noteIds).toContain(noteId) // found by exact substring, no fact required

    const res = await run(db, m, 'purge')
    expect(res.messagesScrubbed).toBe(1)
    const [note] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.c).not.toContain('Lena Okafor')
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

    const m = await findMemoryToForget(db, GROUP, { values: ['Lena Okafor'], subject: '', attribute: '' })
    expect(m.facts).toHaveLength(0) // NONE of the roztoc/github/mother rows are dragged in
    expect(m.noteIds).toHaveLength(0)
  })

  it('resolves subject + attribute to the ONE exact fact value (not the whole person)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('lena', 'full_name', 'Lena Okafor'), authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, { groupId: GROUP, fact: person('lena', 'room', 'front room 2'), authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Lena Okafor has front room 2', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, { values: [], subject: 'Lena', attribute: 'full name' })
    expect(m.facts).toHaveLength(1) // ONLY the full_name fact
    expect(m.facts[0].label).toContain('Lena Okafor')
    expect(m.scrubValues).toContain('Lena Okafor')
    expect(m.noteIds).toContain(noteId)
    expect(m.facts.some((f) => f.label.includes('front room 2'))).toBe(false) // the room is NOT targeted
  })

  it('PURGE scrubs only the value from a multi-person message, keeping the rest', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const intro = "I'm Ryan Noble, Felix is Felix Brandt, and Lena is Lena Okafor"
    const noteId = await captureMemory({ groupId: GROUP, content: intro, memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await reconcileFact(db, { groupId: GROUP, fact: person('lena', 'full_name', 'Lena Okafor'), authoredBy: null, trustLevel: 'untrusted' })

    const m = await findMemoryToForget(db, GROUP, { values: ['Lena Okafor'], subject: '', attribute: '' })
    await run(db, m, 'purge')
    const [note] = await db.select({ c: memoryItems.content, a: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.a).toBe(true)
    expect(note.c).not.toContain('Lena Okafor')
    expect(note.c).toContain('Ryan Noble')
    expect(note.c).toContain('Felix Brandt')
  })

  it('drops the value as an entity alias but keeps the entity + other aliases', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('lena', 'full_name', 'Lena Okafor'), authoredBy: null, trustLevel: 'untrusted' })
    const [ent] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'lena')))
    await db.update(entities).set({ aliases: ['lena okafor', 'mad'] }).where(eq(entities.id, ent.id))

    const m = await findMemoryToForget(db, GROUP, { values: ['Lena Okafor'], subject: '', attribute: '' })
    expect(m.aliasHits.some((h) => h.remove.includes('lena okafor'))).toBe(true)
    const res = await run(db, m, 'purge')
    expect(res.aliasesRemoved).toBe(1)
    const [after] = await db.select({ aliases: entities.aliases }).from(entities).where(eq(entities.id, ent.id))
    expect(after.aliases).toContain('mad') // the permitted alias stays
    expect(after.aliases).not.toContain('lena okafor')
  })

  it('SOFT hides facts but leaves messages + aliases untouched (reversible)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: person('lena', 'full_name', 'Lena Okafor'), authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Lena is Lena Okafor btw', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, { values: ['Lena Okafor'], subject: '', attribute: '' })
    const res = await run(db, m, 'soft')
    expect(res.messagesScrubbed).toBe(0)
    expect(res.aliasesRemoved).toBe(0)
    expect(res.facts).toBe(1)
    expect(await currentFactsForQuery(db, GROUP, 'lena full name')).toHaveLength(0) // fact hidden
    const [note] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.c).toContain('Lena Okafor') // message intact
  })

  it('NEVER touches another house’s rows (group-scoped)', async () => {
    const db = await makeTestDb()
    const OTHER = '-100other'
    await ensureRegistered(db, GROUP, null)
    await ensureRegistered(db, OTHER, null)
    const otherNote = await captureMemory({ groupId: OTHER, content: 'Lena Okafor in the other house', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    // scoped to GROUP but handed OTHER's ids → no-op
    const res = await forgetMemory(db, GROUP, { factIds: [], scrubValues: ['Lena Okafor'], noteIds: [otherNote], aliasHits: [], mode: 'purge' })
    expect(res.messagesScrubbed).toBe(0)
    const [n] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, otherNote))
    expect(n.c).toContain('Lena Okafor')
  })
})
