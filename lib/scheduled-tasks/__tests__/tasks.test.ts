import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { createReminder } from '@/lib/reminders/store'
import { createScheduledTask, dueTasks, recordRun, cancelScheduledTask } from '@/lib/scheduled-tasks/store'
import { computeNextRun } from '@/lib/scheduled-tasks/cadence'
import { buildDigest } from '@/lib/scheduled-tasks/digest'

const GROUP = '-100st'
const zeroEmbed = async () => new Array<number>(1536).fill(0)

describe('scheduled tasks store + dispatch semantics', () => {
  it('due → run → advance next_run_at (recurring task stays active but not re-due)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const id = await createScheduledTask(db, {
      groupId: GROUP,
      prompt: 'check specials',
      cadence: 'weekly',
      nextRunAt: new Date(Date.now() - 1000),
      requesterMemberId: '100',
    })
    expect((await dueTasks(db, new Date())).map((d) => d.id)).toContain(id)

    await recordRun(db, id, computeNextRun('weekly', DateTime.now()), null)
    expect((await dueTasks(db, new Date())).map((d) => d.id)).not.toContain(id)
  })

  it('a task past until_expiry deactivates', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const until = new Date(Date.now() + 1000)
    const id = await createScheduledTask(db, {
      groupId: GROUP,
      prompt: 'x',
      cadence: 'weekly',
      nextRunAt: new Date(Date.now() - 1000),
      untilExpiry: until,
      requesterMemberId: '100',
    })
    await recordRun(db, id, computeNextRun('weekly', DateTime.now()), until) // +7d is past `until`
    expect((await dueTasks(db, new Date(Date.now() + 1e10))).map((d) => d.id)).not.toContain(id)
  })

  it('cancel deactivates', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const id = await createScheduledTask(db, {
      groupId: GROUP,
      prompt: 'x',
      cadence: 'weekly',
      nextRunAt: new Date(Date.now() - 1000),
      requesterMemberId: '100',
    })
    expect(await cancelScheduledTask(db, id)).toBe(true)
    expect((await dueTasks(db, new Date())).map((d) => d.id)).not.toContain(id)
  })
})

describe('buildDigest — grounded from DB records', () => {
  it('summarizes upcoming reminders + recent notes', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await createReminder(db, {
      groupId: GROUP,
      deliverChatId: GROUP,
      content: 'pay rent',
      fireAt: new Date(Date.now() + 2 * 86_400_000),
      createdBy: '100',
    })
    await captureMemory(
      { groupId: GROUP, content: 'Marta arrives friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed: zeroEmbed },
    )
    const d = await buildDigest(db, GROUP)
    expect(d).toContain('House digest')
    expect(d).toContain('pay rent')
    expect(d).toContain('Marta arrives friday')
  })

  it('says nothing on file when empty', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    expect(await buildDigest(db, GROUP)).toContain('Nothing on file')
  })
})
