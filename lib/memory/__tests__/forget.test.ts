import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { facts, memoryItems, memoryEmbeddings } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { retrieve } from '@/lib/memory/retrieve'
import { findMemoryToForget, forgetMemory } from '@/lib/memory/forget'
import { embedSync } from '@/lib/ai/embed'

const GROUP = '-100forget'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64')
const embed = async (t: string) => embedSync(t)

describe('deletion on request (forget)', () => {
  it('finds the facts + notes that match a target', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'full_name', object: 'Madeleine Goujon' }, authoredBy: null, trustLevel: 'untrusted' })
    await captureMemory({ groupId: GROUP, content: 'Madeleine Goujon just moved into front room 2', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, 'Madeleine Goujon', { db, embed })
    expect(m.factIds).toHaveLength(1) // the full_name fact
    expect(m.noteIds.length).toBeGreaterThanOrEqual(1) // the evidence note
    expect(m.candidates.some((c) => c.content.includes('Madeleine Goujon'))).toBe(true)
    // the shown candidates and the delete-ids are the SAME rows
    expect(m.factIds.length + m.noteIds.length).toBe(m.candidates.length)
  })

  it('SOFT delete hides a fact + note from recall but keeps the rows', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'full_name', object: 'Madeleine Goujon' }, authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Madeleine Goujon lives here', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, 'Madeleine Goujon', { db, embed })
    const res = await forgetMemory(db, GROUP, { factIds: m.factIds, noteIds: m.noteIds, mode: 'soft' })
    expect(res.facts).toBe(1)
    expect(res.notes).toBeGreaterThanOrEqual(1)

    // gone from recall …
    expect(await currentFactsForQuery(db, GROUP, 'what is madeleine full name')).toHaveLength(0)
    expect((await retrieve('Madeleine Goujon', { groupId: GROUP, floor: 0 }, { db, embed })).length).toBe(0)
    // … but the rows still exist (reversible / audit)
    const [note] = await db.select({ active: memoryItems.isActive, content: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.active).toBe(false)
    expect(note.content).toContain('Madeleine Goujon') // soft keeps the text
  })

  it('PURGE redacts the fact value, the note content, AND drops the embedding', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'full_name', object: 'Madeleine Goujon' }, authoredBy: null, trustLevel: 'untrusted' })
    const noteId = await captureMemory({ groupId: GROUP, content: 'Madeleine Goujon phone stuff', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })

    const m = await findMemoryToForget(db, GROUP, 'Madeleine Goujon', { db, embed })
    await forgetMemory(db, GROUP, { factIds: m.factIds, noteIds: m.noteIds, mode: 'purge' })

    // the plaintext is GONE from the DB, not just hidden
    const [fact] = await db.select({ v: facts.objectValue }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'full_name')))
    expect(fact.v).toBe('[redacted on request]')
    const [note] = await db.select({ c: memoryItems.content }).from(memoryItems).where(eq(memoryItems.id, noteId))
    expect(note.c).not.toContain('Madeleine Goujon')
    // and the vector is deleted so it can't resurface semantically
    const embs = await db.select({ id: memoryEmbeddings.id }).from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryItemId, noteId))
    expect(embs).toHaveLength(0)
  })

  it('NEVER deletes another house’s rows (group-scoped WHERE guard)', async () => {
    const db = await makeTestDb()
    const OTHER = '-100other'
    await ensureRegistered(db, GROUP, null)
    await ensureRegistered(db, OTHER, null)
    // a fact + note in the OTHER house
    await reconcileFact(db, { groupId: OTHER, fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'full_name', object: 'Madeleine Goujon' }, authoredBy: null, trustLevel: 'untrusted' })
    const otherNote = await captureMemory({ groupId: OTHER, content: 'Madeleine Goujon note in other house', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    const otherFact = (await db.select({ id: facts.id }).from(facts).where(eq(facts.groupId, OTHER)))[0]

    // attempt to forget the OTHER house's ids while scoped to GROUP → no-op
    const res = await forgetMemory(db, GROUP, { factIds: [otherFact.id], noteIds: [otherNote], mode: 'purge' })
    expect(res.facts).toBe(0)
    expect(res.notes).toBe(0)
    const [stillThere] = await db.select({ c: memoryItems.content, a: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, otherNote))
    expect(stillThere.a).toBe(true)
    expect(stillThere.c).toContain('Madeleine Goujon') // untouched
  })
})
