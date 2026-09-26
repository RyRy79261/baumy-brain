import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { withSimulatedTime } from '@/lib/core/clock'
import { saveReminderDraft, takeReminderDraft } from '@/lib/reminders/draft'
import { resolvePendingAction } from '@/lib/confirm/store'
import { pendingWork } from '@/lib/console/pending'
import { pendingActions } from '@/db/schema'

// A reminder waiting for its time (A2/A3 follow-up): kept per (house, chat, requester), consumed
// one-shot, short-lived — and never a confirm card a tap could resolve.
const HOUSE = '-100draft'
const key = { groupId: HOUSE, chatId: HOUSE, requestedBy: '701' }

describe('reminder drafts', () => {
  it('is taken once by the same requester in the same chat — then gone', async () => {
    const db = await makeTestDb()
    await saveReminderDraft(db, key, 'call the landlord')
    expect(await takeReminderDraft(db, { ...key, requestedBy: '702' })).toBeNull() // someone else
    expect(await takeReminderDraft(db, { ...key, chatId: '701' })).toBeNull() // another chat (their DM)
    expect(await takeReminderDraft(db, key)).toEqual({ content: 'call the landlord' })
    expect(await takeReminderDraft(db, key)).toBeNull() // one-shot
  })

  it('expires', async () => {
    const db = await makeTestDb()
    const t0 = new Date('2026-09-28T08:00:00Z')
    await withSimulatedTime(t0, () => saveReminderDraft(db, key, 'call the landlord'))
    expect(await withSimulatedTime(new Date(t0.getTime() + 7 * 3600_000), () => takeReminderDraft(db, key))).toBeNull()
  })

  it('is not a confirm card: a tap naming it is refused, and the console does not list it', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, HOUSE, null)
    await saveReminderDraft(db, key, 'call the landlord')
    const [row] = await db.select({ id: pendingActions.id }).from(pendingActions)
    expect(await resolvePendingAction(db, row.id, 'confirmed')).toBeNull()
    expect((await pendingWork(db, HOUSE, new Date())).confirms).toHaveLength(0)
    expect(await takeReminderDraft(db, key)).toEqual({ content: 'call the landlord' }) // still intact
  })
})
