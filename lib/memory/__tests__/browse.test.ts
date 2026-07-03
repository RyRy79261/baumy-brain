import { describe, it, expect } from 'vitest'
import { makeTestDb, fakeEmbed } from './pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import { listCurrentFacts, listRecentMemories } from '@/lib/memory/browse'

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const GROUP = '-100browse'
const embed = async (t: string) => fakeEmbed(t)

describe('dashboard memory browse', () => {
  it('NEVER leaks a secret — a secure fact/memory shows only a descriptor', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'wifi', predicate: 'password', object: 'hunter2Berlin' },
      authoredBy: null,
      trustLevel: 'trusted',
    })
    await captureMemory(
      { groupId: GROUP, content: 'the wifi password is hunter2Berlin', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    const facts = await listCurrentFacts(db, GROUP)
    const wifi = facts.find((f) => f.subject === 'wifi')
    expect(wifi?.isSecure).toBe(true)
    expect(wifi?.objectValue).toBeNull() // ciphertext is never selected
    expect(JSON.stringify(facts)).not.toContain('hunter2')

    const mems = await listRecentMemories(db, GROUP)
    expect(mems.some((m) => m.isSecure)).toBe(true)
    expect(JSON.stringify(mems)).not.toContain('hunter2') // content is the descriptor only
  })

  it('lists current facts + recent memories for the group', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'recycling', predicate: 'due_day', object: 'friday' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    await captureMemory(
      { groupId: GROUP, content: 'bins go out tuesday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    expect((await listCurrentFacts(db, GROUP)).some((f) => f.subject === 'recycling')).toBe(true)
    expect((await listRecentMemories(db, GROUP)).some((m) => m.content.includes('bins'))).toBe(true)
  })
})
