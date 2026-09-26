// AUDIT REPRO (action flows: shopping list routing). Real runIngest + PGlite; model/Voyage/Telegram
// mocked. A PASSING test == the finding is confirmed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig, memoryItems } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, EXTRACT_LIST_SYSTEM, REPLY_SYSTEM } from '@/lib/ai/prompts'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

const dbh: { db: any } = { db: null }
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})
const systems: string[] = []
let triage: ClassifierVerdict
let listObj: { op: string; items: string[] } = { op: 'none', items: [] }

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (opts: { system: string; prompt: string }) => {
      systems.push(opts.system)
      if (opts.system === TRIAGE_SYSTEM) return { object: triage }
      if (opts.system === EXTRACT_FACTS_SYSTEM) return { object: { facts: [] } }
      if (opts.system === EXTRACT_LIST_SYSTEM) return { object: listObj }
      if (opts.system === REPLY_SYSTEM) return { object: { reply: 'the wifi is on the fridge', answered: true, needsStrongerModel: false } }
      return { object: {} }
    },
  }
})
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t), embedMany: async (ts: string[]) => ts.map((t) => actual.embedSync(t)) }
})
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumy_bot',
  sendConfirmCard: async () => {},
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')

const HOUSE = '-100actlist'
const CHARLI = 777
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }
let uid = 0
const ev = (over: Partial<TelegramMessageData>): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid, messageId: uid, chatId: HOUSE, chatType: 'supergroup', fromId: CHARLI,
    fromFirstName: 'Charli', fromLastName: null, fromUsername: null, text: 'x',
    isBot: false, isForwarded: false, replyToBot: false, ...over,
  },
})
const V = (o: Partial<ClassifierVerdict>): ClassifierVerdict => ({
  worthRemembering: false, intent: 'chatter', needsReply: false, confidence: 0.9, respond: 'ignore',
  reaction: null, tier: 'quick', webSearch: false, list: 'none', ...o,
})

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  systems.length = 0
  sendToHouse.mockClear(); reactToMessage.mockClear()
})

describe('list early-return swallows the rest of the message', () => {
  it('"@baumy add milk to the list — and what\'s the wifi password?" → milk added, ✍, the question is never answered', async () => {
    triage = V({ list: 'add', intent: 'question', needsReply: true, respond: 'answer' })
    listObj = { op: 'add', items: ['milk'] }
    const res = await runIngest(ev({ text: "@baumy_bot add milk to the list — and what's the wifi password?" }), step)
    expect(res.decision).toBe('list')
    expect(systems).not.toContain(REPLY_SYSTEM) // reply path never runs
    expect(sendToHouse).not.toHaveBeenCalled()
    expect(reactToMessage.mock.calls.at(-1)?.[2]).toBe('✍') // K1 fixed the emoji; A10 (question dropped) is still open
  })
})

describe('list ops are ALSO captured as memory and never retired', () => {
  it('"we\'re out of milk" is stored as an active note; after "got the milk" the note is still active grounding', async () => {
    triage = V({ list: 'add', worthRemembering: true, intent: 'fact' })
    listObj = { op: 'add', items: ['milk'] }
    await runIngest(ev({ text: "we're out of milk" }), step)
    triage = V({ list: 'checkoff', worthRemembering: true, intent: 'fact' })
    listObj = { op: 'checkoff', items: ['milk'] }
    await runIngest(ev({ text: 'got the milk' }), step)
    const notes = await dbh.db.select().from(memoryItems).where(and(eq(memoryItems.groupId, HOUSE), eq(memoryItems.isActive, true)))
    const contents = notes.map((n: { content: string }) => n.content)
    expect(contents).toContain("we're out of milk") // still says we're out, forever
  })
})
