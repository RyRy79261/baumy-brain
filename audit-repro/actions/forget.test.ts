// AUDIT REPRO (action flows: forget + confirm-tap). A PASSING test == the finding is confirmed
// (each asserts the CURRENT, buggy behaviour). Offline: PGlite + embedSync; Telegram mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { facts, houseConfig } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { reconcileFact } from '@/lib/memory/facts'
import { findMemoryToForget, forgetMemory } from '@/lib/memory/forget'
import { retrieve } from '@/lib/memory/retrieve'
import { createPendingAction } from '@/lib/confirm/store'

const dbh: { db: any } = { db: null }
const answerCallback = vi.fn(async (..._a: unknown[]) => {})
const editMessageText = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/telegram/client', () => ({
  answerCallback: (...a: unknown[]) => answerCallback(...a),
  editMessageText: (...a: unknown[]) => editMessageText(...a),
}))
// Make inngest.createFunction hand back the raw handler so the test can invoke it directly.
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, createFunction: (_a: unknown, _b: unknown, h: unknown) => h } }
})

const { handleCallbackQuery } = (await import('@/lib/inngest/functions/callback')) as unknown as {
  handleCallbackQuery: (ctx: { event: { data: Record<string, unknown> }; step: unknown }) => Promise<Record<string, unknown>>
}

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const HOUSE = '-100actforget'
const CHARLI = 777
const CHARLI_DM = String(CHARLI)
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() }
const emb = async (t: string) => embedSync(t)

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  answerCallback.mockClear()
  editMessageText.mockClear()
})

async function seedZuzkaFact() {
  await reconcileFact(dbh.db, {
    groupId: HOUSE,
    fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'value' },
    authoredBy: String(CHARLI),
    trustLevel: 'untrusted',
  })
  const [f] = await dbh.db.select().from(facts).where(eq(facts.groupId, HOUSE))
  return f
}

describe('forget confirm-tap executes against the TAPPED chat, not the house scope', () => {
  it('DM forget: card proposed with groupId=house, but the tap runs forgetMemory(chatId=DM) → 0 rows, fact still current, "Forgotten — 0 facts"', async () => {
    const f = await seedZuzkaFact()
    // What ingest.ts:459-471 stores for a DM forget: scope = house.
    const pid = await createPendingAction(dbh.db, {
      groupId: HOUSE,
      actionType: 'memory.forget',
      payload: { mode: 'soft', factIds: [f.id], scrubValues: [], noteIds: [], aliasHits: [], summary: 'zuzka staying' },
      requestedBy: String(CHARLI),
    })
    // Charli taps ✅ on the card Baumy sent into her DM (webhook sets chatId = cq.message.chat.id = her DM).
    const res = await handleCallbackQuery({ event: { data: { callbackId: 'cb1', fromId: CHARLI, chatId: CHARLI_DM, messageId: 5, data: `c:${pid}` } }, step })
    expect(res.forgot).toBe(0)
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(true) // NOT forgotten
    expect(String(editMessageText.mock.calls.at(-1)?.[2])).toContain('Forgotten — 0 facts') // user told it worked
  })

  it('post-supergroup-migration: tap in the live -100… chat (≠ scope id) also forgets nothing', async () => {
    const f = await seedZuzkaFact()
    const pid = await createPendingAction(dbh.db, {
      groupId: HOUSE,
      actionType: 'memory.forget',
      payload: { mode: 'soft', factIds: [f.id], scrubValues: [], noteIds: [], aliasHits: [], summary: 'x' },
      requestedBy: String(CHARLI),
    })
    const res = await handleCallbackQuery({ event: { data: { callbackId: 'cb2', fromId: CHARLI, chatId: '-1009999live', messageId: 6, data: `c:${pid}` } }, step })
    expect(res.forgot).toBe(0)
    const [after] = await dbh.db.select().from(facts).where(eq(facts.id, f.id))
    expect(after.isCurrent).toBe(true)
  })
})

describe('forget resolution / soft mode gaps', () => {
  it('"forget Zuzka" (value = the name) never matches facts whose SUBJECT is Zuzka — only object values are searched', async () => {
    await seedZuzkaFact()
    await captureMemory({ groupId: HOUSE, content: 'Zuzka is staying in my room this weekend', memoryType: 'fact', authoredBy: String(CHARLI), trustLevel: 'untrusted', salience: 0.85 }, { db: dbh.db, embed: emb })
    const m = await findMemoryToForget(dbh.db, HOUSE, { values: ['Zuzka'], subject: 'Zuzka', attribute: '' })
    expect(m.facts).toEqual([]) // the zuzka→staying_in fact is not proposed
    expect(m.noteIds.length).toBe(1) // → soft mode replies "That's only in past messages…"
  })

  it('SOFT forget hides the fact but the source note stays active and is still retrieved as grounding', async () => {
    const f = await seedZuzkaFact()
    await captureMemory({ groupId: HOUSE, content: 'Zuzka is staying in my room this weekend', memoryType: 'fact', authoredBy: String(CHARLI), trustLevel: 'untrusted', salience: 0.85 }, { db: dbh.db, embed: emb })
    const r = await forgetMemory(dbh.db, HOUSE, { factIds: [f.id], scrubValues: ["charli's room"], noteIds: [], aliasHits: [], mode: 'soft' })
    expect(r.facts).toBe(1)
    const hits = await retrieve('where is Zuzka staying this weekend', { groupId: HOUSE, k: 8, floor: 0.05 }, { db: dbh.db, embed: emb })
    expect(hits.some((h) => h.content.includes('Zuzka is staying in my room'))).toBe(true) // "forgotten" info still answers
  })

  it('subject+attribute lookup requires EVERY attribute word inside predicate+value (natural phrasing misses)', async () => {
    await seedZuzkaFact() // predicate staying_in, value "charli's room"
    const m = await findMemoryToForget(dbh.db, HOUSE, { values: [], subject: 'Zuzka', attribute: 'where she is sleeping' })
    expect(m.facts).toEqual([]) // "sleeping"/"where"/"she" not in "staying in charli's room" → "Nothing like that in my memory"
  })
})
