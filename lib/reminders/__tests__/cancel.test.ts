import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { reminders } from '@/db/schema'
import { createReminder, markSent, loadSeriesRow, scheduleNextOccurrence } from '@/lib/reminders/store'
import { cancellableReminders, cancelRemindersOnTap, contentWords, matchReminders, reminderLabel, type CancelCandidate } from '@/lib/reminders/cancel'

// Reminder cancellation from chat (docs/spec/reminders.md §Cancelling from chat): the extractor only
// DESCRIBES which reminder; this code resolves the description to concrete rows the asker may see, and
// the tap cancels exactly those rows' series in the stored scope — re-checked against the tapper.

const HOUSE = '-100cancel'
const CHLOE = '701'
const MARCO = '702'
const TZ = 'Europe/Berlin'
const FRI = new Date('2026-10-02T18:00:00Z') // Fri 2 Oct 20:00 Berlin

const cand = (content: string, o: Partial<CancelCandidate> = {}): CancelCandidate => ({ id: content, content, fireAt: FRI, recurrence: null, personal: false, ...o })

describe('matchReminders — the description resolved by code', () => {
  const rows = [cand('put the bins out'), cand('Chloe: call mum', { personal: true }), cand('call the plumber'), cand('pay the rent')]
  it('content words ignore case, articles, "reminder", possessives and plain plurals', () => {
    expect(contentWords('The BINS reminder!')).toEqual(['bin'])
    expect(contentWords("Chloe's reminder to call mum")).toEqual(['chloe', 'call', 'mum'])
  })
  it('every target word must be in the reminder (precision-first)', () => {
    expect(matchReminders(rows, 'bins')).toEqual({ kind: 'match', rows: [rows[0]] })
    expect(matchReminders(rows, 'call mum')).toEqual({ kind: 'match', rows: [rows[1]] })
    expect(matchReminders(rows, 'the plumber')).toEqual({ kind: 'match', rows: [rows[2]] })
  })
  it('a partial match only when nothing matches fully, sharing at least half the words', () => {
    expect(matchReminders(rows, 'putting the bins out')).toEqual({ kind: 'match', rows: [rows[0]] }) // bin + out of putting/bin/out
    expect(matchReminders(rows, 'water the plants')).toEqual({ kind: 'nothing' })
  })
  it('different reminders matching → ambiguous (ask which); a duplicate is one thing', () => {
    expect(matchReminders(rows, 'call')).toMatchObject({ kind: 'ambiguous', rows: [rows[1], rows[2]] })
    const dup = [cand('put the bins out', { id: 'a' }), cand('put the bins out', { id: 'b' })]
    expect(matchReminders(dup, 'bins')).toMatchObject({ kind: 'match', rows: dup })
  })
  it('no target words → vague', () => {
    expect(matchReminders(rows, '')).toEqual({ kind: 'vague' })
    expect(matchReminders(rows, 'my reminder')).toEqual({ kind: 'vague' })
  })
})

describe('reminderLabel', () => {
  it('names a series by its repeat, a one-off by its day, a personal one as such', () => {
    expect(reminderLabel(cand('put the bins out', { recurrence: 'FREQ=WEEKLY;BYDAY=FR' }), TZ)).toBe('⏰ put the bins out — every Friday 20:00')
    expect(reminderLabel(cand('Chloe: call mum', { personal: true }), TZ)).toBe('⏰ Chloe: call mum — Fri 2 Oct 20:00 (just for you)')
  })
})

async function seed() {
  const db = await makeTestDb()
  await ensureRegistered(db, HOUSE, Number(CHLOE))
  await ensureRegistered(db, HOUSE, Number(MARCO))
  await ensureRegistered(db, '-100other', Number(MARCO))
  const bins = await createReminder(db, { groupId: HOUSE, deliverChatId: HOUSE, content: 'put the bins out', fireAt: FRI, createdBy: MARCO, recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
  const mum = await createReminder(db, { groupId: HOUSE, deliverChatId: CHLOE, content: 'Chloe: call mum', fireAt: FRI, createdBy: CHLOE })
  const heads = await createReminder(db, { groupId: HOUSE, deliverChatId: HOUSE, content: 'heads-up', fireAt: FRI, createdBy: null, anchorKind: 'event_offset' })
  const other = await createReminder(db, { groupId: '-100other', deliverChatId: '-100other', content: 'put the bins out', fireAt: FRI, createdBy: MARCO })
  return { db, bins, mum, heads, other }
}
const statusOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string) => (await db.select({ s: reminders.status }).from(reminders).where(eq(reminders.id, id)))[0]?.s

describe('cancellableReminders — what the asker may see', () => {
  it('the house lane sees house reminders only — no personal DM reminder, no heads-up, no other house', async () => {
    const { db, bins } = await seed()
    expect((await cancellableReminders(db, HOUSE, null)).map((r) => r.id)).toEqual([bins])
  })
  it("a member's own DM also sees their personal reminders — never another member's", async () => {
    const { db, bins, mum } = await seed()
    expect((await cancellableReminders(db, HOUSE, CHLOE)).map((r) => r.id).sort()).toEqual([bins, mum].sort())
    expect((await cancellableReminders(db, HOUSE, MARCO)).map((r) => r.id)).toEqual([bins])
  })
})

describe('cancelRemindersOnTap — the tap, re-checked against the tapper', () => {
  it('cancels a house reminder for any member tap, in the stored scope only', async () => {
    const { db, bins, other } = await seed()
    expect(await cancelRemindersOnTap(db, HOUSE, [bins, other], CHLOE)).toEqual([bins])
    expect(await statusOf(db, bins)).toBe('cancelled')
    expect(await statusOf(db, other)).toBe('scheduled') // another scope's row is never touched
  })
  it("a personal DM reminder is cancelled only by its creator's tap", async () => {
    const { db, mum } = await seed()
    expect(await cancelRemindersOnTap(db, HOUSE, [mum], MARCO)).toEqual([])
    expect(await statusOf(db, mum)).toBe('scheduled')
    expect(await cancelRemindersOnTap(db, HOUSE, [mum], CHLOE)).toEqual([mum])
  })
  it('never a heads-up', async () => {
    const { db, heads } = await seed()
    expect(await cancelRemindersOnTap(db, HOUSE, [heads], CHLOE)).toEqual([])
  })
  it('a series that delivered and rolled on between card and tap: its NEXT occurrence is cancelled', async () => {
    const { db, bins } = await seed()
    await markSent(db, bins)
    const next = await scheduleNextOccurrence(db, (await loadSeriesRow(db, bins))!, FRI, TZ)
    expect(next).toBeTruthy()
    expect(await cancelRemindersOnTap(db, HOUSE, [bins], CHLOE)).toEqual([next])
    expect(await statusOf(db, bins)).toBe('sent') // what was posted stays posted
    expect(await statusOf(db, next!)).toBe('cancelled')
  })
})
