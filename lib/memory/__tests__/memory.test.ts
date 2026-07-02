import { describe, it, expect } from 'vitest'
import { makeTestDb, fakeEmbed } from './pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'

const GROUP = '-100test'
const embed = async (t: string) => fakeEmbed(t)

describe('memory store → recall (PGlite + pgvector)', () => {
  it('recalls the semantically-matching item first', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await captureMemory(
      { groupId: GROUP, content: 'rent is due friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    const res = await retrieve('when is the rent due', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].content).toBe('rent is due friday')
    expect(res[0].authoredBy).toBe('100')
  })

  it('scopes retrieval to the group (no cross-group leakage)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await ensureRegistered(db, '-100other', 200)
    await captureMemory(
      { groupId: '-100other', content: 'rent is due friday', memoryType: 'fact', authoredBy: '200', trustLevel: 'untrusted' },
      { db, embed },
    )

    const res = await retrieve('rent due', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.length).toBe(0)
  })

  it('a similarity floor filters out unrelated items (honest miss)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    const res = await retrieve('what is the door code', { groupId: GROUP, floor: 0.3 }, { db, embed })
    expect(res.length).toBe(0)
  })
})
