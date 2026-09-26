import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { setConsoleThread } from '@/lib/identity/house'
import { houseConfig } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, REPLY_SYSTEM } from '@/lib/ai/prompts'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

// AUDIT REPRO (reply/voice area). Drives the REAL runIngest end to end — real classify()/extractFacts()/
// answer() wrappers, real capture + reconcile + hybrid retrieve + currentFactsForQuery against PGlite —
// and mocks ONLY the model transport (`ai`.generateObject), Voyage (→ embedSync) and Telegram.
// It captures the exact prompt the REPLY model receives for the "Charli" scenario.

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
  worthRemembering: true,
  intent: 'fact',
  needsReply: false,
  confidence: 0.9,
  respond: 'react',
  reaction: null,
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

function assertCharliBug(prompt: string) {
  // A2: nothing tells the model WHO is talking — "Charli" appears only as the author of memory rows.
  expect(prompt).not.toMatch(/SPEAKER|SENDER|from Charli:|Charli (asks|says|wrote)/i)
  // A3: the statement is framed as a QUESTION.
  expect(prompt).toContain('QUESTION (data): ')
  // A1: the MEMORY block already contains the very message being replied to (captured moments earlier),
  // attributed to Charli — so the model "answers" Charli by quoting Charli back.
  const memory = prompt.split('MEMORY:\n')[1].split('\n\nQUESTION')[0]
  expect(memory).toMatch(/from Charli\) (@baumy_bot )?Zuzka is staying in my room this weekend/)
  expect(memory).toMatch(/from Charli\) zuzka staying in: charli's room/)
}

describe('Charli scenario — what the reply model actually receives', () => {
  it('(a) @mention statement → reply path; prompt has no speaker, frames it as a QUESTION, MEMORY holds the message itself', async () => {
    const res = await runIngest(ev({ text: '@baumy_bot Zuzka is staying in my room this weekend' }), step)
    expect(res.directed).toBe(true)
    expect(replyCalls()).toHaveLength(1)
    const p = replyCalls()[0].prompt
    assertCharliBug(p)
    // the words go out (directed ⇒ always words even when answered=false) — the 🧠 ack is lost
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    expect(reactToMessage.mock.calls.map((c) => c[2])).not.toContain('🧠')
    // eslint-disable-next-line no-console
    console.log('\n===== (a) REPLY PROMPT =====\n' + p + '\n============================\n')
  })

  it('(b) /baumyhere topic: a plain statement (even one addressed to another housemate) is forced down the reply path', async () => {
    await setConsoleThread(dbh.db, 42)
    const res = await runIngest(ev({ text: 'Zuzka is staying in my room this weekend', messageThreadId: 42 }), step)
    expect(res.directed).toBe(true)
    expect(replyCalls()).toHaveLength(1)
    assertCharliBug(replyCalls()[0].prompt)
    expect(sendToHouse).toHaveBeenCalledTimes(1) // words, not 🧠
  })

  it('(b2) /baumyhere topic: Marco asking CHARLI a question is answered by Baumy', async () => {
    await setConsoleThread(dbh.db, 42)
    triageVerdict = { ...STATEMENT, worthRemembering: false, intent: 'question', respond: 'answer', needsReply: true }
    await runIngest(ev({ fromId: MARCO, fromFirstName: 'Marco', text: 'Charli are you around tonight?', messageThreadId: 42 }), step)
    expect(replyCalls()).toHaveLength(1)
    expect(sendToHouse).toHaveBeenCalledTimes(1)
  })

  it('(c) DM statement: the classifier is never told this is a DM; "answer" OR a reply-to-Baumy sends it to the reply path', async () => {
    // Plain DM statement with the realistic react verdict → 🧠 only (no reply) — OK.
    await runIngest(ev({ chatId: String(CHARLI), chatType: 'private' }), step)
    expect(replyCalls()).toHaveLength(0)
    const triage = calls.find((c) => c.system === TRIAGE_SYSTEM)!
    expect(triage.prompt).not.toMatch(/private|DM|direct message|lane/i) // classifier sees text only
    // Same DM statement sent as a Telegram reply to any earlier Baumy message → directed → reply path.
    calls.length = 0
    await runIngest(ev({ chatId: String(CHARLI), chatType: 'private', replyToBot: true }), step)
    expect(replyCalls()).toHaveLength(1)
    assertCharliBug(replyCalls()[0].prompt)
  })

  it('(d) undirected group statement misread as respond=answer → reply model gets it as a QUESTION; answered=false ⇒ 👎 on an informative statement, 🧠 lost', async () => {
    triageVerdict = { ...STATEMENT, respond: 'answer', confidence: 0.9 }
    const res = await runIngest(ev({}), step)
    expect(res.directed).toBe(false)
    expect(replyCalls()).toHaveLength(1)
    assertCharliBug(replyCalls()[0].prompt)
    expect(sendToHouse).not.toHaveBeenCalled()
    expect(reactToMessage.mock.calls.map((c) => c[2])).toEqual(['👀', '👎'])
  })

  it('A1 corollary: an ambient question that was captured can never hit the "blank" honest-miss — its own echo is always in MEMORY', async () => {
    triageVerdict = { ...STATEMENT, intent: 'question', respond: 'answer', needsReply: true, confidence: 0.95, worthRemembering: true }
    replyObject = { reply: 'nothing on that', answered: false, needsStrongerModel: false }
    await runIngest(ev({ fromId: MARCO, fromFirstName: 'Marco', text: 'when is the plumber coming?' }), step)
    const p = replyCalls()[0].prompt
    expect(p).toMatch(/\(question, from Marco\) when is the plumber coming\?/)
    expect(p).not.toContain('(no relevant memory found)')
    // grounding non-empty → 👎 instead of the informative "we've never mentioned that"
    expect(reactToMessage.mock.calls.map((c) => c[2])).toEqual(['👀', '👎'])
  })
})

describe('first-person questions — the asker is unknown to the reply model', () => {
  it('Charli asks "who is staying in my room this weekend?" — prompt never says the asker is Charli; the fact row keyed on "charli\'s room" is not even retrieved', async () => {
    await runIngest(ev({ fromId: MARCO, fromFirstName: 'Marco', text: 'Zuzka is staying in Charli\'s room this weekend' }), step)
    calls.length = 0
    triageVerdict = { ...STATEMENT, worthRemembering: false, intent: 'question', respond: 'answer', needsReply: true, confidence: 0.95 }
    replyObject = { reply: 'no idea whose room that is', answered: false, needsStrongerModel: false }
    await runIngest(ev({ text: '@baumy_bot who is staying in my room this weekend?' }), step)
    const p = replyCalls()[0].prompt
    // eslint-disable-next-line no-console
    console.log('\n===== first-person REPLY PROMPT =====\n' + p + '\n=====================================\n')
    expect(p).not.toMatch(/asked by Charli|SPEAKER|SENDER/i)
    // currentFactsForQuery substring-matches entity names inside the query text; "my room" never
    // contains "zuzka", so the structured fact is missing from grounding
    expect(p).not.toMatch(/zuzka staying in: charli's room/)
  })
})
