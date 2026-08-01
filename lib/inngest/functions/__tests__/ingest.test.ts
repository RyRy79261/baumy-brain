import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { listItems } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { resolveHouseIds, setReminderThread } from '@/lib/identity/house'
import { addListItems } from '@/lib/lists/store'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

// End-to-end wiring coverage: drive a real message through the WHOLE ingest handler (classify →
// gate → the list step → store → ack), with a fake Inngest step and a PGlite DB, so the shopping
// -list routing is proven as it actually composes — not just the seams. LLM + Telegram are mocked;
// everything else (origin, decide, policy, roster, the store, the SQL) is the real code path.

// A mutable holder so the hoisted db/client mock returns THIS test's PGlite instance.
const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractMock = vi.fn<(t: string) => Promise<{ op: string; items: string[] }>>()
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/client')>()
  return { ...actual, createHttpDb: () => dbh.db }
})
vi.mock('@/lib/ai/classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/classify')>()
  return { ...actual, classify: (t: string) => classifyMock(t) }
})
vi.mock('@/lib/ai/list-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/list-extract')>()
  return { ...actual, extractListOp: (t: string) => extractMock(t) }
})
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumybot',
  sendConfirmCard: async () => {},
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')

const HOUSE = '-100ingest'
const MEMBER = 810
const DM = String(MEMBER) // a member's private chat id
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() } // inline, no memoization

let uid = 0
const event = (over: Partial<TelegramMessageData> = {}): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid,
    messageId: uid,
    chatId: DM,
    chatType: 'private',
    fromId: MEMBER,
    fromFirstName: 'Ryan',
    fromLastName: null,
    fromUsername: null,
    text: 'buy milk',
    isBot: false,
    isForwarded: false,
    replyToBot: false,
    ...over,
  },
})

const verdict = (over: Partial<ClassifierVerdict>): ClassifierVerdict => ({
  worthRemembering: false,
  intent: 'chatter',
  needsReply: false,
  confidence: 0.5,
  respond: 'ignore',
  reaction: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
  ...over,
})

const openItems = async () =>
  (await dbh.db.select({ item: listItems.item }).from(listItems).where(and(eq(listItems.groupId, HOUSE), eq(listItems.isActive, true)))).map(
    (r: { item: string }) => r.item,
  )

describe('ingest handler — shopping list end-to-end (real routing, mocked LLM/Telegram)', () => {
  beforeAll(() => {
    process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  })
  beforeEach(async () => {
    dbh.db = await makeTestDb()
    await ensureRegistered(dbh.db, HOUSE, null) // house chat exists
    await upsertMember(dbh.db, HOUSE, String(MEMBER), 'Ryan', 'member') // roster knows the member
    classifyMock.mockReset()
    extractMock.mockReset()
    sendToHouse.mockClear()
    reactToMessage.mockClear()
  })

  it('a member DM "buy milk" writes THROUGH to the house list + confirms privately', async () => {
    classifyMock.mockResolvedValue(verdict({ list: 'add' }))
    extractMock.mockResolvedValue({ op: 'add', items: ['milk'] })

    const res = await runIngest(event({ text: 'buy milk' }), step)

    expect(res.decision).toBe('list')
    // wrote through to the HOUSE scope (not the private chat), attributed to the member
    const [row] = await dbh.db.select().from(listItems).where(eq(listItems.groupId, HOUSE))
    expect(row.item).toBe('milk')
    expect(row.addedBy).toBe(String(MEMBER))
    // confirmed privately to the DM chat, never the group; no group-noise reaction
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    expect(sendToHouse.mock.calls[0][0]).toBe(DM)
    expect(String(sendToHouse.mock.calls[0][1])).toContain('Added milk')
    expect(reactToMessage).not.toHaveBeenCalled()
  })

  it('a FORWARDED (quarantined) "buy milk" can NEVER touch the list — even flagged as add', async () => {
    classifyMock.mockResolvedValue(verdict({ list: 'add' })) // classifier still says add…
    extractMock.mockResolvedValue({ op: 'add', items: ['milk'] })

    await runIngest(event({ text: 'buy milk', isForwarded: true }), step)

    // …but quarantine blocks the mutation before the extractor even runs
    expect(await openItems()).toEqual([])
    expect(extractMock).not.toHaveBeenCalled()
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  it('a member DM "what\'s on the list?" renders the current list and does NOT double-reply', async () => {
    await addListItems(dbh.db, { groupId: HOUSE, items: ['milk', 'eggs'], addedBy: null })
    // a list query is ALSO a question (respond=answer) — proves the list branch preempts the
    // generic reply (one send, the rendered list) instead of both firing.
    classifyMock.mockResolvedValue(verdict({ list: 'query', intent: 'question', needsReply: true, respond: 'answer', confidence: 0.9 }))
    extractMock.mockResolvedValue({ op: 'query', items: [] })

    const res = await runIngest(event({ text: "what's on the list?" }), step)

    expect(res.decision).toBe('list')
    expect(sendToHouse).toHaveBeenCalledTimes(1) // NOT two (list render + generic reply)
    const sent = String(sendToHouse.mock.calls[0][1])
    expect(sent).toContain('Shopping list')
    expect(sent).toContain('milk')
    expect(sent).toContain('eggs')
  })
})

// The reminders "notification channel": an owner points reminders at a forum topic by running
// /notifyhere INSIDE it. Authorization = authenticated owner id; value = authenticated
// message_thread_id — never message text. (docs/spec/telegram.md)
describe('ingest handler — /notifyhere reminders-topic capture (owner-gated, house lane)', () => {
  const OWNER = 900
  beforeEach(async () => {
    dbh.db = await makeTestDb()
    await ensureRegistered(dbh.db, HOUSE, null)
    await upsertMember(dbh.db, HOUSE, String(OWNER), 'Boss', 'owner')
    await upsertMember(dbh.db, HOUSE, String(MEMBER), 'Ryan', 'member')
    classifyMock.mockReset()
    extractMock.mockReset()
    sendToHouse.mockClear()
    reactToMessage.mockClear()
  })

  const houseCmd = (over: Partial<TelegramMessageData> = {}) =>
    event({ chatId: HOUSE, chatType: 'supergroup', fromId: OWNER, ...over })

  it('owner /notifyhere inside a topic pins it as the reminders channel + confirms in that topic', async () => {
    const res = await runIngest(houseCmd({ text: '/notifyhere', messageThreadId: 55 }), step)
    expect(res.decision).toBe('notify-config')
    expect((await resolveHouseIds(dbh.db)).reminderThreadId).toBe(55)
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    expect(sendToHouse.mock.calls[0][0]).toBe(HOUSE)
    expect(sendToHouse.mock.calls[0][2]).toMatchObject({ threadId: 55 })
  })

  it('/notifyoff resets to the General topic', async () => {
    await setReminderThread(dbh.db, 55)
    const res = await runIngest(houseCmd({ text: '/notifyoff', messageThreadId: 55 }), step)
    expect(res.decision).toBe('notify-config')
    expect((await resolveHouseIds(dbh.db)).reminderThreadId).toBeNull()
  })

  it('a NON-owner /notifyhere can NOT change the channel (falls through, owner-gated)', async () => {
    classifyMock.mockResolvedValue(verdict({})) // chatter → no capture, no reply
    const res = await runIngest(houseCmd({ fromId: MEMBER, text: '/notifyhere', messageThreadId: 55 }), step)
    expect(res.decision).not.toBe('notify-config')
    expect((await resolveHouseIds(dbh.db)).reminderThreadId).toBeNull()
  })

  it('owner /notifyhere in the General topic (no thread) pins nothing and says where to run it', async () => {
    const res = await runIngest(houseCmd({ text: '/notifyhere', messageThreadId: null }), step)
    expect(res.decision).toBe('notify-config')
    expect((await resolveHouseIds(dbh.db)).reminderThreadId).toBeNull()
    expect(String(sendToHouse.mock.calls[0][1])).toContain('INSIDE the topic')
  })
})
