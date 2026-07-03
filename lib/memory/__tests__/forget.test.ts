import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { facts, memoryItems, memoryEmbeddings } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { findMemoryToForget, forgetMemory, redactValues } from '@/lib/memory/forget'
import { embedSync } from '@/lib/ai/embed'

const GROUP = '-100forget'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64')
const embed = async (t: string) => embedSync(t)
const fullName = (subject: string, value: string) => ({ subject, subjectKind: 'person' as const, predicate: 'full_name', object: value })

describe('deletion on request (forget) — facts are the unit, messages are scrubbed not deleted', () => {
  it('redactValues scrubs case-insensitively and keeps the surrounding text', () => {
    expect(redactValues("I'm Ryan, and madeleine goujon lives here", ['Madeleine Goujon'])).toBe("I'm Ryan, and [redacted] lives here")
  })

  it('resolves a target to the fact + value to scrub + the messages that hold it', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: fullName('madeleine', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })
    const withVal = await captureMemory({ groupId: GROUP, content: 'Madeleine Goujon moved into front room 2', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    const without = await captureMemory({ groupId: GROUP, content: 'the bins go out on tuesday', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, 'Madeleine Goujon')
    expect(m.factIds).toHaveLength(1)
    expect(m.facts[0].label).toContain('Madeleine Goujon')
    expect(m.scrubValues).toEqual(['Madeleine Goujon'])
    expect(m.noteIds).toContain(withVal) // the message holding the value
    expect(m.noteIds).not.toContain(without) // an unrelated message is never touched
  })

  it('PURGE scrubs ONLY the value from a multi-person source message, keeping the rest', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    // ONE intro message that sources facts about MANY people — the exact collateral-damage case
    const intro = "I'm Ryan Noble, Charl is Charl Jacobs, and Madeleine is Madeleine Goujon"
    const noteId = await captureMemory({ groupId: GROUP, content: intro, memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await reconcileFact(db, { groupId: GROUP, fact: fullName('madeleine', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })

    const m = await findMemoryToForget(db, GROUP, "Madeleine's full name")
    expect(m.scrubValues).toContain('Madeleine Goujon')
    expect(m.noteIds).toContain(noteId)

    const res = await forgetMemory(db, GROUP, { factIds: m.factIds, scrubValues: m.scrubValues, noteIds: m.noteIds, mode: 'purge' })
    expect(res.facts).toBe(1)
    expect(res.messagesScrubbed).toBe(1)

    const [note] = await db.select({ content: memoryItems.content, active: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.active).toBe(true) // the MESSAGE SURVIVES
    expect(note.content).not.toContain('Madeleine Goujon') // the name is scrubbed
    expect(note.content).toContain('Ryan Noble') // everyone else's info is intact
    expect(note.content).toContain('Charl Jacobs')
    expect(note.content).toContain('[redacted]')
    // the fact value is redacted too, and the stale vector is dropped for re-embedding
    const [fact] = await db.select({ v: facts.objectValue }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'full_name')))
    expect(fact.v).toBe('[redacted on request]')
    expect(await db.select({ id: memoryEmbeddings.id }).from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryItemId, noteId))).toHaveLength(0)
  })

  it('SOFT hides the fact but leaves the source message completely untouched (reversible)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const noteId = await captureMemory({ groupId: GROUP, content: 'Madeleine is Madeleine Goujon btw', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await reconcileFact(db, { groupId: GROUP, fact: fullName('madeleine', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })

    const m = await findMemoryToForget(db, GROUP, "Madeleine's full name")
    const res = await forgetMemory(db, GROUP, { factIds: m.factIds, scrubValues: m.scrubValues, noteIds: m.noteIds, mode: 'soft' })
    expect(res.messagesScrubbed).toBe(0) // soft NEVER touches a source message

    expect(await currentFactsForQuery(db, GROUP, 'madeleine full name')).toHaveLength(0) // fact hidden
    const [note] = await db.select({ content: memoryItems.content, active: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.active).toBe(true)
    expect(note.content).toContain('Madeleine Goujon') // message intact + reversible
  })

  it('NEVER touches another house’s rows (group-scoped guard)', async () => {
    const db = await makeTestDb()
    const OTHER = '-100other'
    await ensureRegistered(db, GROUP, null)
    await ensureRegistered(db, OTHER, null)
    await reconcileFact(db, { groupId: OTHER, fact: fullName('madeleine', 'Madeleine Goujon'), authoredBy: null, trustLevel: 'untrusted' })
    const otherNote = await captureMemory({ groupId: OTHER, content: 'Madeleine Goujon in the other house', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    const otherFact = (await db.select({ id: facts.id }).from(facts).where(eq(facts.groupId, OTHER)))[0]

    // scoped to GROUP but handed OTHER's ids + value → no-op
    const res = await forgetMemory(db, GROUP, { factIds: [otherFact.id], scrubValues: ['Madeleine Goujon'], noteIds: [otherNote], mode: 'purge' })
    expect(res.facts).toBe(0)
    expect(res.messagesScrubbed).toBe(0)
    const [n] = await db.select({ c: memoryItems.content, a: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, otherNote))
    expect(n.a).toBe(true)
    expect(n.c).toContain('Madeleine Goujon') // untouched
  })
})
