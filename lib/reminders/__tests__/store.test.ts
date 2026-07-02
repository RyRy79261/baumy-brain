import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { createReminder, claimReminder, markSent, cancelReminder, dueScheduled } from '@/lib/reminders/store'

const GROUP = '-100rem'
const mk = (fireAt: Date, content = 'pay rent') => ({ groupId: GROUP, deliverChatId: GROUP, content, fireAt, createdBy: '100' })

describe('reminders store', () => {
  it('atomic claim: only the FIRST caller wins (exactly-once delivery)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const id = await createReminder(db, mk(new Date(Date.now() - 1000)))
    expect(await claimReminder(db, id)).toBe(true) // deliver path
    expect(await claimReminder(db, id)).toBe(false) // concurrent sweeper loses
    await markSent(db, id)
    expect(await claimReminder(db, id)).toBe(false) // already sent
  })

  it('a cancelled reminder can never be claimed (never fires)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const id = await createReminder(db, mk(new Date(Date.now() + 60_000)))
    expect(await cancelReminder(db, id)).toBe(true)
    expect(await claimReminder(db, id)).toBe(false)
  })

  it('dueScheduled returns only overdue scheduled rows', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await createReminder(db, mk(new Date(Date.now() - 1000), 'overdue'))
    await createReminder(db, mk(new Date(Date.now() + 86_400_000), 'future'))
    const due = await dueScheduled(db, new Date())
    expect(due.length).toBe(1)
    expect(due[0].content).toBe('overdue')
  })
})
