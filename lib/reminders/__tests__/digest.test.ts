import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { createReminder } from '@/lib/reminders/store'

const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ sendToHouse: (...a: unknown[]) => sendToHouse(...a) }))
const { deliverDueReminders } = await import('@/lib/inngest/functions/reminders')

const GROUP = '-100digest'
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('reminder digest — batched, exactly-once delivery', () => {
  beforeEach(() => sendToHouse.mockClear())

  it('batches all due reminders into ONE message (explicit + event heads-up) and marks them sent', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'call the landlord', fireAt: minsAgo(30), createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out tonight', fireAt: minsAgo(10), anchorKind: 'event_offset', createdBy: null })

    const res = await deliverDueReminders(db, new Date())
    expect(res).toEqual({ sent: 2, messages: 1 }) // two reminders → ONE message
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    const body = String(sendToHouse.mock.calls[0][1])
    expect(body).toContain('⏰ call the landlord') // explicit → ⏰
    expect(body).toContain('🗓️ bins out tonight') // event heads-up → 🗓️
    const rows = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(rows.every((r) => r.status === 'sent')).toBe(true)
  })

  it('is idempotent — a second run delivers nothing (claim-once)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'x', fireAt: minsAgo(5), createdBy: null })
    await deliverDueReminders(db, new Date())
    sendToHouse.mockClear()
    expect((await deliverDueReminders(db, new Date())).sent).toBe(0)
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  it('does not deliver a future reminder', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'later', fireAt: new Date(Date.now() + 3_600_000), createdBy: null })
    expect((await deliverDueReminders(db, new Date())).sent).toBe(0)
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  it('a send failure releases the batch back to scheduled (retries, never zero-fire)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'y', fireAt: minsAgo(5), createdBy: null })
    sendToHouse.mockRejectedValueOnce(new Error('telegram down'))
    await expect(deliverDueReminders(db, new Date())).rejects.toThrow()
    const [row] = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(row.status).toBe('scheduled') // released → will retry next slot
    // next run (send works) delivers it
    expect((await deliverDueReminders(db, new Date())).sent).toBe(1)
  })
})
