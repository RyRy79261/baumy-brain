import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { createReminder } from '@/lib/reminders/store'
import { EMBED_DIM } from '@/lib/ai/embed'
import { buildDigest } from '@/lib/reports/digest'

const GROUP = '-100digest'
const zeroEmbed = async () => new Array<number>(EMBED_DIM).fill(0)

describe('buildDigest — deterministic house digest (the /weekly fallback)', () => {
  it('summarizes upcoming reminders + recent notes', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await createReminder(db, {
      groupId: GROUP,
      deliverChatId: GROUP,
      content: 'take the bins out',
      fireAt: new Date(Date.now() + 2 * 86_400_000),
      createdBy: '100',
    })
    await captureMemory(
      { groupId: GROUP, content: 'Marta arrives friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed: zeroEmbed },
    )
    const d = await buildDigest(db, GROUP)
    expect(d).toContain('House digest')
    expect(d).toContain('take the bins out')
    expect(d).toContain('Marta arrives friday')
  })

  it('says nothing on file when empty', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    expect(await buildDigest(db, GROUP)).toContain('Nothing on file')
  })
})
