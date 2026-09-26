import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, REPLY_SYSTEM } from '@/lib/ai/prompts'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

// AUDIT REPRO (reply/voice area). Drives the REAL runIngest end to end — real classify()/extractFacts()/
// answer() wrappers, real capture + reconcile + hybrid retrieve + currentFactsForQuery against PGlite —
// and mocks ONLY the model transport (`ai`.generateObject), Voyage (→ embedSync) and Telegram.
//
// Phase 1 (chat-understanding-v2 §1–§4) fixed and removed the "Charli scenario" repros — no speaker
// (C2), statement framed as a QUESTION (C3), grounded on itself (C1), statements routed to the reply
// path / 👎 on news (C4), console-topic housemate questions answered (C6), the DM classifier blind to
// its lane. The correct behaviour lives in scenarios/charli + routing, lib/turn/__tests__/plan.test.ts
// and lib/ai/__tests__/reply.test.ts. What is still open is below.

const dbh: { db: any } = { db: null }
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})

type Call = { system: string; prompt: string }
const calls: Call[] = []
let triageVerdict: ClassifierVerdict
let replyObject = { reply: "No idea — Charli said Zuzka's staying", answered: false, needsStrongerModel: false }

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (opts: { system: string; prompt: string }) => {
      calls.push({ system: opts.system, prompt: opts.prompt })
      if (opts.system === TRIAGE_SYSTEM) return { object: triageVerdict }
      if (opts.system === EXTRACT_FACTS_SYSTEM) {
        // What a good extractor does with the speaker line (first page only; drain on the second).
        if (opts.prompt.includes('ALREADY CAPTURED')) return { object: { facts: [] } }
        return {
          object: {
            facts: [
              { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'place', whenText: 'this weekend' },
            ],
          },
        }
      }
      if (opts.system === REPLY_SYSTEM) return { object: replyObject }
      return { object: {} }
    },
  }
})
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return {
    ...actual,
    embed: async (t: string) => actual.embedSync(t),
    embedMany: async (ts: string[]) => ts.map((t) => actual.embedSync(t)),
  }
})
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumy_bot',
  sendConfirmCard: async () => {},
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')

const HOUSE = '-100charli'
const CHARLI = 777
const MARCO = 778
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }
let uid = 0
const ev = (over: Partial<TelegramMessageData>): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid,
    messageId: uid,
    chatId: HOUSE,
    chatType: 'supergroup',
    fromId: CHARLI,
    fromFirstName: 'Charli',
    fromLastName: null,
    fromUsername: null,
    text: 'Zuzka is staying in my room this weekend',
    isBot: false,
    isForwarded: false,
    replyToBot: false,
    ...over,
  },
})

// A realistic Haiku verdict for a plain informative statement.
const STATEMENT: ClassifierVerdict = {
  intent: 'statement',
  asksBaumy: false,
  worthRemembering: true,
  confidence: 0.9,
  vibe: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
}

const replyCalls = () => calls.filter((c) => c.system === REPLY_SYSTEM)

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  await upsertMember(dbh.db, HOUSE, String(MARCO), 'Marco', 'member')
  calls.length = 0
  sendToHouse.mockClear()
  reactToMessage.mockClear()
  triageVerdict = STATEMENT
  replyObject = { reply: "No idea — Charli said Zuzka's staying", answered: false, needsStrongerModel: false }
})

describe('first-person questions — "my room" is not resolved to the asker in the fact lookup (F13 → phase 4)', () => {
  it('Charli asks "who is staying in my room this weekend?" — the fact keyed on "charli\'s room" is not retrieved', async () => {
    await runIngest(ev({ fromId: MARCO, fromFirstName: 'Marco', text: "Zuzka is staying in Charli's room this weekend" }), step)
    calls.length = 0
    triageVerdict = { ...STATEMENT, worthRemembering: false, intent: 'question', asksBaumy: true, confidence: 0.95 }
    replyObject = { reply: 'no idea whose room that is', answered: false, needsStrongerModel: false }
    await runIngest(ev({ text: '@baumy_bot who is staying in my room this weekend?' }), step)
    const p = replyCalls()[0].prompt
    // (C2 fixed: the prompt now says FROM: Charli, so the model CAN resolve "my" — but) the fact lookup
    // substring-matches entity names inside the query text; "my room" never contains "zuzka", so the
    // structured fact is missing from grounding.
    expect(p).toMatch(/FROM: Charli/)
    expect(p).not.toMatch(/- fact · [^\n]*zuzka staying in/)
  })
})
