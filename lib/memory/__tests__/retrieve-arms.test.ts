import { describe, it, expect } from 'vitest'
import { makeTestDb } from './pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { embedSync } from '@/lib/ai/embed'

// The hybrid retrieval arms (spec §7): the lexical arm is an OR of the question's terms (F14), and
// "what did X say" adds X's own notes as an author arm (F13). The semantic arm is neutralised here
// (a query vector unrelated to every note + a 0.99 floor) so each arm is tested on its own.
const GROUP = '-100arms'
const junk = async () => embedSync('completely unrelated vocabulary xyzzy plugh')

describe('retrieval arms', () => {
  it('a natural question lexically matches a note that shares ANY term (OR, ranked by overlap)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const deps = { db, embed: async (t: string) => embedSync(t) }
    const zosia = await captureMemory({ groupId: GROUP, content: 'Zosia is staying in my room this weekend', memoryType: 'statement', authoredBy: null, trustLevel: 'untrusted' }, deps)
    await captureMemory({ groupId: GROUP, content: 'the bins go out on friday', memoryType: 'statement', authoredBy: null, trustLevel: 'untrusted' }, deps)
    const hits = await retrieve('when does zosia arrive?', { groupId: GROUP, k: 8, floor: 0.99 }, { db, embed: junk })
    expect(hits.map((h) => h.id)).toEqual([zosia]) // "arrive" is absent, "zosia" is enough — the bins note shares nothing
  })

  it('the author arm surfaces the named housemate\'s own words', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 20, 'Theo')
    await ensureRegistered(db, GROUP, 30, 'Rui')
    const deps = { db, embed: async (t: string) => embedSync(t) }
    const theo = await captureMemory({ groupId: GROUP, content: 'I think we can spend four hundred max', memoryType: 'statement', authoredBy: '20', trustLevel: 'untrusted' }, deps)
    await captureMemory({ groupId: GROUP, content: 'gear budget is flexible', memoryType: 'statement', authoredBy: '30', trustLevel: 'untrusted' }, deps)
    const without = await retrieve('what did theo say about the gear budget?', { groupId: GROUP, k: 8, floor: 0.99 }, { db, embed: junk })
    expect(without.map((h) => h.id)).not.toContain(theo)
    const withAuthor = await retrieve('what did theo say about the gear budget?', { groupId: GROUP, k: 8, floor: 0.99, authorId: '20' }, { db, embed: junk })
    expect(withAuthor.map((h) => h.id)).toContain(theo)
  })
})
