import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember, deactivateMember } from '@/lib/identity/roster'
import { createReminder } from '@/lib/reminders/store'
import { upcomingRemindersReport } from '@/lib/reports/reports'

// The reminder destination allow-list (docs/spec/chat-understanding-v2.md D2, A5): a house reminder goes
// to the house group, a personal reminder set in a member DM goes to THAT member's DM — never mixed into
// the house digest, never re-routed to the group, retired if its creator has left.

const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ sendToHouse: (...a: unknown[]) => sendToHouse(...a) }))
const { deliverDueReminders, deliverReminderNow } = await import('@/lib/inngest/functions/reminders')

const GROUP = '-100dest'
const CHARLI = '801'
const TZ = 'Europe/Berlin'
const now = new Date('2026-09-26T18:00:00Z')
const ago = (m: number) => new Date(now.getTime() - m * 60_000)

async function house() {
  process.env.BAUMY_HOUSE_CHAT_ID = GROUP
  const db = await makeTestDb()
  await ensureRegistered(db, GROUP, null)
  await upsertMember(db, GROUP, CHARLI, 'Charli', 'member')
  return db
}

describe('reminder destinations (D2)', () => {
  beforeEach(() => sendToHouse.mockClear())

  it('the digest sends the house batch to the house and a personal reminder to its creator’s DM — separately', async () => {
    const db = await house()
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out', fireAt: ago(20), createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: CHARLI, content: 'Charli: take my antibiotics', fireAt: ago(10), createdBy: CHARLI })
    const res = await deliverDueReminders(db, now, TZ)
    expect(res).toMatchObject({ sent: 2, messages: 2 })
    expect(sendToHouse.mock.calls.map((c) => [c[0], c[1]]).sort()).toEqual([
      [GROUP, '⏰ bins out'],
      [CHARLI, '⏰ Charli: take my antibiotics'],
    ])
  })

  it('the explicit path posts a personal reminder to the DM only', async () => {
    const db = await house()
    const id = await createReminder(db, { groupId: GROUP, deliverChatId: CHARLI, content: 'Charli: call mum', fireAt: ago(1), createdBy: CHARLI })
    expect(await deliverReminderNow(db, id, now, TZ)).toMatchObject({ status: 'sent' })
    expect(sendToHouse.mock.calls.map((c) => c[0])).toEqual([CHARLI])
  })

  it('a personal reminder of a member who has LEFT is retired — never re-routed to the group', async () => {
    const db = await house()
    const id = await createReminder(db, { groupId: GROUP, deliverChatId: CHARLI, content: 'Charli: call mum', fireAt: ago(1), createdBy: CHARLI })
    await deactivateMember(db, CHARLI)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await deliverReminderNow(db, id, now, TZ)).toMatchObject({ status: 'undeliverable' })
    const [row] = await db.select().from(reminders).where(eq(reminders.id, id))
    expect(row.status).toBe('cancelled')
    await createReminder(db, { groupId: GROUP, deliverChatId: CHARLI, content: 'Charli: other', fireAt: ago(1), createdBy: CHARLI })
    await deliverDueReminders(db, now, TZ)
    warn.mockRestore()
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  it('/reminders in the group never lists a personal DM reminder; the creator’s own DM does', async () => {
    const db = await house()
    const later = new Date(now.getTime() + 3_600_000)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out', fireAt: later, createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: CHARLI, content: 'Charli: take my antibiotics', fireAt: later, createdBy: CHARLI })
    const group = await upcomingRemindersReport(db, GROUP, TZ, now)
    expect(group).toContain('bins out')
    expect(group).not.toContain('antibiotics')
    const dm = await upcomingRemindersReport(db, GROUP, TZ, now, CHARLI)
    expect(dm).toContain('antibiotics — ') // listed…
    expect(dm).toContain('just for you')
    expect(await upcomingRemindersReport(db, GROUP, TZ, now, '999')).not.toContain('antibiotics') // …only to its creator
  })
})
