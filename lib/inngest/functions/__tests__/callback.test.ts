import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { auditLog, facts, houseConfig, reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { reconcileFact } from '@/lib/memory/facts'
import { createPendingAction } from '@/lib/confirm/store'
import { createReminder } from '@/lib/reminders/store'

// The forget confirm-tap (the confirm wall) executes against the pending action's STORED house
// scope — never the chat the button was tapped in (A1). Driven through the real handler with a
// PGlite DB; Telegram is mocked.
const dbh: { db: any } = { db: null }
const answerCallback = vi.fn(async (..._a: unknown[]) => {})
const editMessageText = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/telegram/client', () => ({
  answerCallback: (...a: unknown[]) => answerCallback(...a),
  editMessageText: (...a: unknown[]) => editMessageText(...a),
}))
// inngest.createFunction hands back the raw handler so the test can invoke it directly.
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, createFunction: (_a: unknown, _b: unknown, h: unknown) => h } }
})

const { handleCallbackQuery } = (await import('@/lib/inngest/functions/callback')) as unknown as {
  handleCallbackQuery: (ctx: { event: { data: Record<string, unknown> }; step: unknown }) => Promise<Record<string, unknown>>
}

const HOUSE = '-100cbhouse'
const CHLOE = 777
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

beforeEach(async () => {
  delete process.env.BAUMY_HOUSE_CHAT_ID
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
  await upsertMember(dbh.db, HOUSE, String(CHLOE), 'Chloe', 'member')
  answerCallback.mockClear()
  editMessageText.mockClear()
})

async function seedFact() {
  await reconcileFact(dbh.db, {
    groupId: HOUSE,
    fact: { subject: 'zosia', subjectKind: 'person', predicate: 'staying_in', object: "chloe's room", objectKind: 'value' },
    authoredBy: String(CHLOE),
    trustLevel: 'untrusted',
  })
  const [f] = await dbh.db.select().from(facts).where(eq(facts.groupId, HOUSE))
  return f
}

const forgetCard = (groupId: string, factId: string) =>
  createPendingAction(dbh.db, {
    groupId,
    actionType: 'memory.forget',
    payload: { mode: 'soft', factIds: [factId], scrubValues: [], noteIds: [], aliasHits: [], summary: 'zosia staying' },
    requestedBy: String(CHLOE),
  })

const tap = (chatId: string, pid: string) =>
  handleCallbackQuery({ event: { data: { callbackId: 'cb', fromId: CHLOE, chatId, messageId: 5, data: `c:${pid}` } }, step })

describe('forget confirm-tap — executes in the stored house scope (A1)', () => {
  it('a DM-originated forget, tapped in the DM, really hides the HOUSE fact', async () => {
    const f = await seedFact()
    const pid = await forgetCard(HOUSE, f.id) // what ingest stores for a DM forget: scope = house
    const res = await tap(String(CHLOE), pid) // card lives in Chloe's DM
    expect(res.forgot).toBe(1)
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(false)
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain('Forgotten — 1 fact')
    // the edit still lands on the card where it was tapped (destination ≠ scope)
    expect(editMessageText.mock.calls.at(-1)?.[0]).toBe(String(CHLOE))
  })

  it('a tap in the migrated live supergroup (≠ scope id) also forgets in the house scope', async () => {
    const f = await seedFact()
    const pid = await forgetCard(HOUSE, f.id)
    const res = await tap('-1009999live', pid)
    expect(res.forgot).toBe(1)
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(false)
  })

  it('fails closed when the stored scope is not the current house scope — nothing is touched', async () => {
    const f = await seedFact()
    await ensureRegistered(dbh.db, '-100elsewhere', null)
    const pid = await forgetCard('-100elsewhere', f.id)
    const res = await tap(HOUSE, pid)
    expect(res.ignored).toBe('scope-mismatch')
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(true)
  })

  it('a non-member tap is refused before anything resolves', async () => {
    const f = await seedFact()
    const pid = await forgetCard(HOUSE, f.id)
    const res = await handleCallbackQuery({ event: { data: { callbackId: 'cb', fromId: 4242, chatId: HOUSE, messageId: 5, data: `c:${pid}` } }, step })
    expect(res.ignored).toBe('not-member')
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(true)
  })
})

// Reminder CANCELLATION rides the same confirm-tap wall (docs/spec/reminders.md §Cancelling from chat):
// the tap cancels exactly the stored reminder ids' series, in the stored house scope, re-checked
// against the tapper (a personal DM reminder: its creator only), audited.
describe('reminder-cancel confirm-tap', () => {
  const MARCO = 778
  const FRI = new Date('2026-10-02T18:00:00Z')
  const status = async (id: string) => (await dbh.db.select({ s: reminders.status }).from(reminders).where(eq(reminders.id, id)))[0]?.s
  const cancelCard = (groupId: string, ids: string[], labels: string[]) =>
    createPendingAction(dbh.db, { groupId, actionType: 'reminder.cancel', payload: { reminderIds: ids, labels, target: 'bins' }, requestedBy: String(CHLOE) })
  const tapAs = (fromId: number, chatId: string, pid: string, verb = 'c') =>
    handleCallbackQuery({ event: { data: { callbackId: 'cb', fromId, chatId, messageId: 9, data: `${verb}:${pid}` } }, step })

  beforeEach(async () => {
    await upsertMember(dbh.db, HOUSE, String(MARCO), 'Marco', 'member')
  })

  it('a tap cancels the house reminder series, edits the card to name it, and is audited', async () => {
    const id = await createReminder(dbh.db, { groupId: HOUSE, deliverChatId: HOUSE, content: 'put the bins out', fireAt: FRI, createdBy: String(CHLOE), recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
    const pid = await cancelCard(HOUSE, [id], ['⏰ put the bins out — every Friday 20:00'])
    const res = await tapAs(MARCO, HOUSE, pid) // any member may confirm a HOUSE reminder's cancellation
    expect(res.remindersCancelled).toBe(1)
    expect(await status(id)).toBe('cancelled')
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toBe('🗑️ Cancelled:\n⏰ put the bins out — every Friday 20:00')
    const audit = await dbh.db.select().from(auditLog).where(eq(auditLog.action, 'reminder.cancel'))
    expect(audit).toHaveLength(1)
    expect(audit[0].actorMemberId).toBe(String(MARCO))
    expect(audit[0].metadata).toMatchObject({ cancelled: [id] })
  })

  it("a personal DM reminder is not cancelled by another member's tap — only by its creator's", async () => {
    const id = await createReminder(dbh.db, { groupId: HOUSE, deliverChatId: String(CHLOE), content: 'Chloe: call mum', fireAt: FRI, createdBy: String(CHLOE) })
    const pid = await cancelCard(HOUSE, [id], ['⏰ Chloe: call mum'])
    const res = await tapAs(MARCO, String(CHLOE), pid)
    expect(res.remindersCancelled).toBe(0)
    expect(await status(id)).toBe('scheduled')
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toMatch(/Nothing cancelled/)
    const pid2 = await cancelCard(HOUSE, [id], ['⏰ Chloe: call mum'])
    expect((await tapAs(CHLOE, String(CHLOE), pid2)).remindersCancelled).toBe(1)
    expect(await status(id)).toBe('cancelled')
  })

  it('the ✖️ button keeps the reminder and says so (not "Cancelled", which would read as done)', async () => {
    const id = await createReminder(dbh.db, { groupId: HOUSE, deliverChatId: HOUSE, content: 'put the bins out', fireAt: FRI, createdBy: String(CHLOE) })
    const pid = await cancelCard(HOUSE, [id], ['⏰ put the bins out'])
    await tapAs(CHLOE, HOUSE, pid, 'x')
    expect(await status(id)).toBe('scheduled')
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toBe('✖️ Kept — no reminder was cancelled.')
    expect((await tapAs(CHLOE, HOUSE, pid)).ignored).toBe('not-pending') // the card is spent
  })

  it('fails closed when the stored scope is not the current house scope', async () => {
    await ensureRegistered(dbh.db, '-100elsewhere', null)
    const id = await createReminder(dbh.db, { groupId: '-100elsewhere', deliverChatId: '-100elsewhere', content: 'x', fireAt: FRI, createdBy: null })
    const pid = await cancelCard('-100elsewhere', [id], ['⏰ x'])
    expect((await tapAs(CHLOE, HOUSE, pid)).ignored).toBe('scope-mismatch')
    expect(await status(id)).toBe('scheduled')
  })
})
