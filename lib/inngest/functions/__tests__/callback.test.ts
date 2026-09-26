import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { facts, houseConfig } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { reconcileFact } from '@/lib/memory/facts'
import { createPendingAction } from '@/lib/confirm/store'

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
const CHARLI = 777
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

beforeEach(async () => {
  delete process.env.BAUMY_HOUSE_CHAT_ID
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'member')
  answerCallback.mockClear()
  editMessageText.mockClear()
})

async function seedFact() {
  await reconcileFact(dbh.db, {
    groupId: HOUSE,
    fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'value' },
    authoredBy: String(CHARLI),
    trustLevel: 'untrusted',
  })
  const [f] = await dbh.db.select().from(facts).where(eq(facts.groupId, HOUSE))
  return f
}

const forgetCard = (groupId: string, factId: string) =>
  createPendingAction(dbh.db, {
    groupId,
    actionType: 'memory.forget',
    payload: { mode: 'soft', factIds: [factId], scrubValues: [], noteIds: [], aliasHits: [], summary: 'zuzka staying' },
    requestedBy: String(CHARLI),
  })

const tap = (chatId: string, pid: string) =>
  handleCallbackQuery({ event: { data: { callbackId: 'cb', fromId: CHARLI, chatId, messageId: 5, data: `c:${pid}` } }, step })

describe('forget confirm-tap — executes in the stored house scope (A1)', () => {
  it('a DM-originated forget, tapped in the DM, really hides the HOUSE fact', async () => {
    const f = await seedFact()
    const pid = await forgetCard(HOUSE, f.id) // what ingest stores for a DM forget: scope = house
    const res = await tap(String(CHARLI), pid) // card lives in Charli's DM
    expect(res.forgot).toBe(1)
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(false)
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain('Forgotten — 1 fact')
    // the edit still lands on the card where it was tapped (destination ≠ scope)
    expect(editMessageText.mock.calls.at(-1)?.[0]).toBe(String(CHARLI))
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
