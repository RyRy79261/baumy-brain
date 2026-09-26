import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { createReminder } from '@/lib/reminders/store'
import { reconcileFact } from '@/lib/memory/facts'
import type { HeadsUpFact } from '@/lib/ai/nudge'
import { withSimulatedTime } from '@/lib/core/clock'
import { setGlobalEnabled } from '@/lib/policy'

const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ sendToHouse: (...a: unknown[]) => sendToHouse(...a) }))
// The heads-up line is written by the model AT DELIVERY (T11) — mocked: it echoes the facts + the lead
// it was given, so the tests see exactly which lead delivery computed.
const writeHeadsUp = vi.fn(async (f: HeadsUpFact[], lead: string, when: string): Promise<string | null> => `${f[0].subject} ${f[0].object} — ${lead} (${when})`)
vi.mock('@/lib/ai/nudge', async (o) => ({ ...(await o<typeof import('@/lib/ai/nudge')>()), writeHeadsUp: (f: HeadsUpFact[], l: string, w: string) => writeHeadsUp(f, l, w) }))
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64')
const { deliverDueReminders, deliverReminderNow } = await import('@/lib/inngest/functions/reminders')
const TZ = 'Europe/Berlin'
const firstFactId = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
  const res = (await db.execute(sql`SELECT id FROM baumy_facts WHERE group_id = ${GROUP}`)) as unknown as { rows?: { id: string }[] } | { id: string }[]
  return String((Array.isArray(res) ? res : (res.rows ?? []))[0].id)
}

const GROUP = '-100digest'
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('reminder digest — batched, exactly-once delivery', () => {
  beforeEach(() => {
    sendToHouse.mockClear()
    writeHeadsUp.mockClear()
  })

  it('batches all due reminders into ONE message (explicit + event heads-up) and marks them sent', async () => {
    // A FIXED instant (Sat 26 Sep 20:00 Berlin, the evening slot) — an event "3h from the wall clock"
    // fell on the next calendar day for anyone running the suite after 21:00, and read "tomorrow".
    const now = new Date('2026-09-26T18:00:00Z')
    const ago = (m: number) => new Date(now.getTime() - m * 60_000)
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const bins = await withSimulatedTime(now, () =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'bins', predicate: 'go_out', object: 'tonight' },
        authoredBy: null,
        trustLevel: 'untrusted',
        eventAt: new Date(now.getTime() + 3_600_000), // 21:00
      }),
    )
    expect(bins).toBe('add')
    const factId = await firstFactId(db)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'call the landlord', fireAt: ago(30), createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out tonight', fireAt: ago(10), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })

    const res = await withSimulatedTime(now, () => deliverDueReminders(db, now, TZ))
    expect(res).toEqual({ sent: 2, messages: 1, expired: 0 }) // two reminders → ONE message
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    const body = String(sendToHouse.mock.calls[0][1])
    expect(body).toBe('⏰ call the landlord\n🗓️ bins tonight — tonight (Sat 26 Sep, 21:00)') // explicit → ⏰; heads-up → 🗓️, written for NOW
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

  it('RETIRES a long-past reminder instead of flushing it into the group', async () => {
    // The "patos" bug: anything that sat un-delivered stayed 'scheduled' forever, and the next
    // digest posted it as if it were now. Past the grace window it is history, not a reminder.
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, {
      groupId: GROUP,
      deliverChatId: GROUP,
      content: 'let them in when they return tomorrow evening',
      fireAt: new Date(Date.now() - 40 * 86_400_000), // ~6 weeks late
      createdBy: null,
    })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out', fireAt: minsAgo(30), createdBy: null })

    const res = await deliverDueReminders(db, new Date())
    expect(res).toEqual({ sent: 1, messages: 1, expired: 1 })
    expect(String(sendToHouse.mock.calls[0][1])).not.toContain('let them in') // never delivered
    const rows = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(rows.find((r) => r.content.startsWith('let them in'))!.status).toBe('cancelled') // audited, not deleted
  })

  it('still delivers a reminder that is late but inside the grace window', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'from last night', fireAt: minsAgo(14 * 60), createdBy: null })
    expect((await deliverDueReminders(db, new Date())).sent).toBe(1)
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

describe('event heads-ups are written at DELIVERY, with the real lead (T11)', () => {
  beforeEach(() => {
    sendToHouse.mockClear()
    writeHeadsUp.mockClear()
  })
  const party = async (db: Awaited<ReturnType<typeof makeTestDb>>) => {
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'marco', subjectKind: 'person', predicate: 'hosting_party', object: 'Sat 3 Oct 22:00' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt: new Date('2026-10-03T20:00:00Z'), // Sat 22:00 Berlin
    })
    return firstFactId(db)
  }

  it('a "tomorrow" stage that only goes out on the event day says today — and one event posts ONE line', async () => {
    // The audit scene: a once-a-day digest, so Friday's 20:00 stage waits for Saturday 08:00, where the
    // morning stage is due too. Old: "party tomorrow (Sat 3 Oct)" + "party today (Sat 3 Oct)" in one post.
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const factId = await party(db)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'marco party tomorrow', fireAt: new Date('2026-10-02T18:00:00Z'), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'marco party today', fireAt: new Date('2026-10-03T06:00:00Z'), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })

    const res = await deliverDueReminders(db, new Date('2026-10-03T06:00:00Z'), TZ) // Sat 08:00
    expect(res.sent).toBe(1)
    const body = String(sendToHouse.mock.calls[0][1])
    expect(body).toBe('🗓️ marco Sat 3 Oct 22:00 — tonight (Sat 3 Oct, 22:00)')
    expect(body).not.toContain('tomorrow')
    const rows = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'sent']) // the stale stage is retired, not posted
    expect(rows.find((r) => r.status === 'sent')!.content).toBe('marco Sat 3 Oct 22:00 — tonight (Sat 3 Oct, 22:00)') // what was actually posted
  })

  it('a heads-up whose event was superseded or is already under way is dropped at delivery', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const factId = await party(db)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'party!', fireAt: new Date('2026-10-03T19:00:00Z'), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })
    const res = await deliverDueReminders(db, new Date('2026-10-03T20:30:00Z'), TZ) // 22:30 — it started
    expect(res.sent).toBe(0)
    expect(sendToHouse).not.toHaveBeenCalled()
    expect(writeHeadsUp).not.toHaveBeenCalled()
  })

  it('a transient model error holds back only the heads-ups — the explicit reminder in the same digest still goes out', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const factId = await party(db)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'party', fireAt: new Date('2026-10-02T18:00:00Z'), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'call the landlord', fireAt: new Date('2026-10-02T17:30:00Z'), createdBy: null })
    writeHeadsUp.mockRejectedValueOnce(new Error('Overloaded'))
    await expect(deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'), TZ)).rejects.toThrow('Overloaded') // rethrown → Inngest retries
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    expect(String(sendToHouse.mock.calls[0][1])).toBe('⏰ call the landlord')
    const rows = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(Object.fromEntries(rows.map((r) => [r.content, r.status]))).toEqual({ 'call the landlord': 'sent', party: 'scheduled' })
    // The retry writes the heads-up; the explicit one is not posted again.
    expect((await deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'), TZ)).sent).toBe(1)
    expect(String(sendToHouse.mock.calls[1][1])).toMatch(/^🗓️ marco/)
  })

  it('a transient model error releases the batch (retried next slot, never lost)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const factId = await party(db)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'party', fireAt: new Date('2026-10-02T18:00:00Z'), anchorKind: 'event_offset', eventFactId: factId, createdBy: null })
    writeHeadsUp.mockRejectedValueOnce(new Error('Overloaded'))
    await expect(deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'), TZ)).rejects.toThrow('Overloaded')
    const [row] = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(row.status).toBe('scheduled')
    expect((await deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'), TZ)).sent).toBe(1)
  })
})

describe('recurring reminders — delivery schedules the next occurrence, exactly once (A6, D3)', () => {
  beforeEach(() => sendToHouse.mockClear())
  const weekly = (db: Awaited<ReturnType<typeof makeTestDb>>, fireAt: Date) =>
    createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'bins out', fireAt, createdBy: null, recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
  const all = (db: Awaited<ReturnType<typeof makeTestDb>>) => db.select().from(reminders).where(eq(reminders.groupId, GROUP))

  it('claim → send → mark-sent → create next; a second delivery attempt creates nothing more', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const id = await weekly(db, new Date('2026-10-02T18:00:00Z')) // Fri 2 Oct 20:00
    const res = await deliverReminderNow(db, id, new Date('2026-10-02T18:00:00Z'), TZ)
    expect(res.status).toBe('sent')
    expect(res.nextId).toBeTruthy()
    expect(await deliverReminderNow(db, id, new Date('2026-10-02T18:00:05Z'), TZ)).toEqual({ status: 'skipped' })
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    const next = rows.find((r) => r.id === res.nextId)!
    expect(next.fireAt.toISOString()).toBe('2026-10-09T18:00:00.000Z') // next Friday 20:00
    expect(next).toMatchObject({ status: 'scheduled', recurrence: 'FREQ=WEEKLY;BYDAY=FR', previousReminderId: id, content: 'bins out' })
  })

  it('a crash between mark-sent and create-next is healed by the digest (and never doubled)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const id = await weekly(db, new Date('2026-10-02T18:00:00Z'))
    await db.update(reminders).set({ status: 'sent' }).where(eq(reminders.id, id)) // sent, successor never created
    await deliverDueReminders(db, new Date('2026-10-03T06:00:00Z'), TZ)
    await deliverDueReminders(db, new Date('2026-10-03T18:00:00Z'), TZ)
    const rows = await all(db)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.previousReminderId === id)!.fireAt.toISOString()).toBe('2026-10-09T18:00:00.000Z')
  })

  it('/pause holds a recurring series — nothing posts, no occurrence is added — and it resumes after /resume', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const daily = await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'water the plants', fireAt: new Date('2026-10-02T18:00:00Z'), createdBy: null, recurrence: 'FREQ=DAILY' })
    await setGlobalEnabled(db, false)
    expect(await deliverReminderNow(db, daily, new Date('2026-10-02T18:00:00Z'), TZ)).toEqual({ status: 'paused' })
    // The daily re-arm fires it again while still paused: still nothing.
    expect(await deliverReminderNow(db, daily, new Date('2026-10-03T06:00:00Z'), TZ)).toEqual({ status: 'paused' })
    expect(sendToHouse).not.toHaveBeenCalled()
    let rows = await all(db)
    expect(rows).toHaveLength(1) // the series did not grow through the kill switch
    expect(rows[0].status).toBe('scheduled') // held, not lost
    // A week later the owner resumes: the digest retires the stale occurrence and the series goes on.
    await setGlobalEnabled(db, true)
    const res = await deliverDueReminders(db, new Date('2026-10-09T06:00:00Z'), TZ)
    expect(res).toMatchObject({ sent: 0, expired: 1 })
    expect(sendToHouse).not.toHaveBeenCalled() // a week-old "water the plants" is not posted as news
    rows = await all(db)
    expect(rows.find((r) => r.previousReminderId === daily)).toMatchObject({ status: 'scheduled', fireAt: new Date('2026-10-09T18:00:00Z') })
  })

  it('/pause holds a one-off too; after /resume inside the grace window it still goes out', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const id = await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'call the landlord', fireAt: new Date('2026-10-02T16:00:00Z'), createdBy: null })
    await setGlobalEnabled(db, false)
    expect((await deliverReminderNow(db, id, new Date('2026-10-02T16:00:00Z'), TZ)).status).toBe('paused')
    expect(sendToHouse).not.toHaveBeenCalled()
    await setGlobalEnabled(db, true)
    expect((await deliverDueReminders(db, new Date('2026-10-02T18:00:00Z'), TZ)).sent).toBe(1)
  })

  it('the staleness window still applies — a missed occurrence is retired, and the series goes on', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const id = await weekly(db, new Date('2026-10-02T18:00:00Z'))
    const res = await deliverDueReminders(db, new Date('2026-10-05T06:00:00Z'), TZ) // Monday: 2.5 days late
    expect(res).toMatchObject({ sent: 0, expired: 1 })
    expect(sendToHouse).not.toHaveBeenCalled() // old news never posted
    const rows = await all(db)
    expect(rows.find((r) => r.id === id)!.status).toBe('cancelled')
    expect(rows.find((r) => r.previousReminderId === id)!.fireAt.toISOString()).toBe('2026-10-09T18:00:00.000Z')
  })
})
