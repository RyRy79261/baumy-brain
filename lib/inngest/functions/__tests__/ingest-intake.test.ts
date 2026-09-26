import { describe, it, expect, beforeEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { memoryItems, members, listItems } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { addListItems } from '@/lib/lists/store'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

// Intake routing through the WHOLE ingest handler (real origin / directedness / prefilter / gate /
// capture / list store / SQL on PGlite); only the LLM + Telegram are mocked. Each block pins one
// audit finding's CORRECT behaviour (docs/spec/chat-understanding-v2.md §1, §8).
const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn(async (..._a: unknown[]) => ({ facts: [] as unknown[] }))
const extractListMock = vi.fn<(t: string) => Promise<{ op: string; items: string[] }>>()
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})
const answerMock = vi.fn(async (..._a: unknown[]) => ({ text: 'sure 🐈', answered: true }))
const retrieveMock = vi.fn(async (..._a: unknown[]) => [])
const factsQueryMock = vi.fn(async (..._a: unknown[]) => [])
const weeklyMock = vi.fn(async (..._a: unknown[]) => 'WEEKLY')

const BOT_ID = 7001
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (...a: unknown[]) => extractFactsMock(...a) }))
vi.mock('@/lib/ai/list-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/list-extract')>()), extractListOp: (t: string) => extractListMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (...a: unknown[]) => answerMock(...a) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/memory/retrieve', async (o) => ({
  ...(await o<typeof import('@/lib/memory/retrieve')>()),
  retrieve: (...a: unknown[]) => retrieveMock(...a),
  retrieveExpanded: (...a: unknown[]) => retrieveMock(...a),
}))
vi.mock('@/lib/memory/facts', async (o) => ({ ...(await o<typeof import('@/lib/memory/facts')>()), currentFactsForQuery: (...a: unknown[]) => factsQueryMock(...a) }))
vi.mock('@/lib/reports/reports', async (o) => ({ ...(await o<typeof import('@/lib/reports/reports')>()), weeklyReport: (...a: unknown[]) => weeklyMock(...a) }))
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumy_bot',
  getBotId: async () => BOT_ID,
  sendConfirmCard: async () => {},
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')

const HOUSE = '-100intake'
const CHARLI = 810
const GROUP_ANON_BOT = 1087968824
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

let uid = 0
const ev = (over: Partial<TelegramMessageData> = {}): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid,
    messageId: uid,
    chatId: HOUSE,
    chatType: 'supergroup',
    fromId: CHARLI,
    fromFirstName: 'Charli',
    fromLastName: null,
    fromUsername: null,
    text: 'hello',
    isBot: false,
    isForwarded: false,
    replyToBot: false,
    replyToMessage: null,
    senderChatId: null,
    ...over,
  },
})
const V = (o: Partial<ClassifierVerdict> = {}): ClassifierVerdict => ({
  intent: 'chatter',
  asksBaumy: false,
  worthRemembering: false,
  confidence: 0.9,
  vibe: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
  ...o,
})
const reactions = () => reactToMessage.mock.calls.map((c) => c[2])
const notes = async () => dbh.db.select().from(memoryItems).where(eq(memoryItems.groupId, HOUSE))

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString('base64')
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'member')
  for (const m of [classifyMock, extractFactsMock, extractListMock, sendToHouse, reactToMessage, answerMock, retrieveMock, factsQueryMock, weeklyMock]) m.mockClear()
  classifyMock.mockResolvedValue(V())
  extractFactsMock.mockResolvedValue({ facts: [] })
})

describe('C7 — a short reply TO Baumy is not prefiltered as noise', () => {
  it('"yes" replying to Baumy reaches triage (directed)', async () => {
    const res = await runIngest(ev({ text: 'yes', replyToMessage: { fromId: BOT_ID, isBot: true, text: 'want me to remind the house?', isTopicRoot: false } }), step)
    expect(res).not.toHaveProperty('reason') // not prefiltered (a write-gate 'drop' of chatter is fine)
    expect(classifyMock).toHaveBeenCalledWith('yes')
    expect(res).toMatchObject({ directed: true })
  })
  it('"ok" in a member DM reaches triage', async () => {
    const res = await runIngest(ev({ chatId: String(CHARLI), chatType: 'private', text: 'ok' }), step)
    expect(res).not.toHaveProperty('reason')
    expect(classifyMock).toHaveBeenCalledWith('ok')
  })
  it('undirected group "yes" is still dropped before any LLM call', async () => {
    const res = await runIngest(ev({ text: 'yes' }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'noise' })
    expect(classifyMock).not.toHaveBeenCalled()
  })
})

describe('C8/C9 — only a reply to BAUMY (by bot id) is directed; never the topic root', () => {
  it('a reply to another bot is not directed — no reply path', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'chatter' }))
    const res = await runIngest(ev({ text: 'lol same', replyToBot: true, replyToMessage: { fromId: 5555, isBot: true, text: 'Poll closes at 9', isTopicRoot: false } }), step)
    expect(res).toMatchObject({ directed: false })
    expect(answerMock).not.toHaveBeenCalled()
  })
  it('the forum topic-root reply (created by GroupAnonymousBot) is not directed', async () => {
    const res = await runIngest(
      ev({ text: 'Zuzka arriving Sat', messageThreadId: 44, replyToBot: true, replyToMessage: { fromId: GROUP_ANON_BOT, isBot: true, text: null, isTopicRoot: true } }),
      step,
    )
    expect(res).toMatchObject({ directed: false })
    expect(answerMock).not.toHaveBeenCalled()
  })
  it('a reply to Baumy IS directed and gets words', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question' }))
    const res = await runIngest(ev({ text: 'and on sunday?', replyToMessage: { fromId: BOT_ID, isBot: true, text: 'bins go out friday', isTopicRoot: false } }), step)
    expect(res).toMatchObject({ directed: true })
    expect(answerMock).toHaveBeenCalledTimes(1)
  })
  it('a legacy event (no replyToMessage field) still honours replyToBot', async () => {
    const e = ev({ text: 'and on sunday?', replyToBot: true })
    delete (e.data as Partial<TelegramMessageData>).replyToMessage
    const res = await runIngest(e, step)
    expect(res).toMatchObject({ directed: true })
  })
})

describe('C12 — the @botname token never reaches triage, memory or retrieval', () => {
  it('stripped from classify + captured content + retrieval, still directed', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    const res = await runIngest(ev({ text: '@baumy_bot Zuzka is staying in my room this weekend' }), step)
    expect(res).toMatchObject({ directed: true })
    expect(classifyMock).toHaveBeenCalledWith('Zuzka is staying in my room this weekend')
    const [n] = await notes()
    expect(n.content).toBe('Zuzka is staying in my room this weekend')
    expect(extractFactsMock.mock.calls[0][0]).toBe('Zuzka is staying in my room this weekend')
    expect(String(retrieveMock.mock.calls[0]?.[0])).not.toContain('@baumy_bot')
    const ctx = answerMock.mock.calls[0]?.[0] as { text: string }
    expect(ctx.text).toBe('Zuzka is staying in my room this weekend')
  })
})

describe('K1 — the "noted" ack is ✍ (a real Bot API reaction)', () => {
  it('an undirected statement Baumy stores gets ✍, never 🧠', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await runIngest(ev({ text: 'the boiler guy comes tuesday' }), step)
    expect(reactions()).toEqual(['✍'])
  })
})

describe('K4 — group list reactions reflect the store outcome', () => {
  it('add of a NEW item → ✍; add of something already on the list → 👀', async () => {
    classifyMock.mockResolvedValue(V({ list: 'add' }))
    extractListMock.mockResolvedValue({ op: 'add', items: ['milk'] })
    await runIngest(ev({ text: 'we need milk' }), step)
    expect(reactions().at(-1)).toBe('✍')
    await runIngest(ev({ text: 'we need milk' }), step)
    expect(reactions().at(-1)).toBe('👀')
    expect(sendToHouse).not.toHaveBeenCalled()
  })
  it('a check-off that matched → 👍', async () => {
    await addListItems(dbh.db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    classifyMock.mockResolvedValue(V({ list: 'checkoff' }))
    extractListMock.mockResolvedValue({ op: 'checkoff', items: ['milk'] })
    await runIngest(ev({ text: 'got the milk' }), step)
    expect(reactions().at(-1)).toBe('👍')
  })
  it('a check-off that matched NOTHING → no 👍; words say it was not on the list', async () => {
    await addListItems(dbh.db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    classifyMock.mockResolvedValue(V({ list: 'checkoff' }))
    extractListMock.mockResolvedValue({ op: 'checkoff', items: ['bin bags'] })
    await runIngest(ev({ text: 'got the bin bags' }), step)
    expect(reactions()).not.toContain('👍')
    expect(String(sendToHouse.mock.calls[0]?.[1])).toContain(`Couldn't find "bin bags"`)
    const [milk] = await dbh.db.select().from(listItems).where(and(eq(listItems.groupId, HOUSE)))
    expect(milk.checkedAt).toBeNull()
  })
})

describe('I7 — unknown slash commands in the house group are ignored', () => {
  it('"/pause" in the group: no classify, no capture, no reply', async () => {
    const res = await runIngest(ev({ text: '/pause' }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'unknown-command' })
    expect(classifyMock).not.toHaveBeenCalled()
    expect(await notes()).toHaveLength(0)
    expect(sendToHouse).not.toHaveBeenCalled()
  })
  it('"/help@baumy_bot" is ignored too; a known report still runs', async () => {
    expect((await runIngest(ev({ text: '/help@baumy_bot' }), step)).decision).toBe('drop')
    expect((await runIngest(ev({ text: '/weekly' }), step)).decision).toBe('report-view')
  })
})

describe('A12 — report commands only run in the house lane or a member DM', () => {
  it('/weekly typed by a housemate in a FOREIGN group posts nothing', async () => {
    const res = await runIngest(ev({ chatId: '-100football', text: '/weekly' }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'out-of-scope' })
    expect(weeklyMock).not.toHaveBeenCalled()
    expect(sendToHouse).not.toHaveBeenCalled()
  })
  it('/weekly in a member DM reads the HOUSE scope and replies privately', async () => {
    const res = await runIngest(ev({ chatId: String(CHARLI), chatType: 'private', text: '/weekly' }), step)
    expect(res.decision).toBe('report-view')
    expect(weeklyMock.mock.calls[0][1]).toBe(HOUSE)
    expect(sendToHouse.mock.calls[0][0]).toBe(String(CHARLI))
  })
})

describe('I8 — anonymous-admin posts are untrusted house text, never a bot "member"', () => {
  const anon = (text: string) =>
    ev({ fromId: GROUP_ANON_BOT, fromFirstName: 'Group', fromUsername: 'GroupAnonymousBot', isBot: true, senderChatId: HOUSE, text })

  it('captured as untrusted (not quarantined), unattributed, facts extracted; GroupAnonymousBot is not registered', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await runIngest(anon('rent goes up to 650 from October'), step)
    const [n] = await notes()
    expect(n.trustLevel).toBe('untrusted')
    expect(n.authoredBy).toBeNull()
    expect(extractFactsMock).toHaveBeenCalledTimes(1)
    const bots = await dbh.db.select().from(members).where(eq(members.telegramUserId, String(GROUP_ANON_BOT)))
    expect(bots).toHaveLength(0)
  })
  it('another bot in the group stays quarantined (no facts) and is not registered either', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await runIngest(ev({ fromId: 5555, fromFirstName: 'PollBot', isBot: true, text: 'Poll: pizza friday?' }), step)
    const [n] = await notes()
    expect(n.trustLevel).toBe('quarantined')
    expect(extractFactsMock).not.toHaveBeenCalled()
    expect(await dbh.db.select().from(members).where(eq(members.telegramUserId, '5555'))).toHaveLength(0)
  })
})

describe('I9 — a question about a secret is never stored as a "secret"', () => {
  it('"what\'s the wifi password again?" is not captured (no secure row)', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true, worthRemembering: true }))
    await runIngest(ev({ text: "what's the wifi password again?" }), step)
    expect(await notes()).toHaveLength(0)
  })
  it('a degraded verdict (chatter) on the same question is still not stored', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'chatter', worthRemembering: true, confidence: 0.5 }))
    await runIngest(ev({ text: "what's the wifi password again?" }), step)
    expect(await notes()).toHaveLength(0)
  })
  it('the STATEMENT of the password is still stored encrypted', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await runIngest(ev({ text: 'the wifi password is hunter2' }), step)
    const [n] = await notes()
    expect(n.isSecure).toBe(true)
    expect(n.content).toBe('the wifi password')
  })
})

describe('I2 — a transient extraction error retries the extraction, never re-stores the note', () => {
  it('Inngest replays the memoized capture step; only extract-facts re-runs', async () => {
    // A memoizing fake step: completed step results are replayed on retry, exactly like Inngest.
    const memo = new Map<string, unknown>()
    const memoStep: any = {
      run: async (id: string, fn: () => Promise<unknown>) => {
        if (memo.has(id)) return memo.get(id)
        const r = await fn()
        memo.set(id, r)
        return r
      },
    }
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    extractFactsMock.mockRejectedValueOnce(new Error('Overloaded'))
    const e = ev({ text: 'the door code is 4471' }) // secure → skips consolidation, so a re-capture would duplicate
    await expect(runIngest(e, memoStep)).rejects.toThrow('Overloaded') // step fails → Inngest retries
    await runIngest(e, memoStep) // the retry
    expect(extractFactsMock).toHaveBeenCalledTimes(2)
    expect(await notes()).toHaveLength(1)
  })
})
