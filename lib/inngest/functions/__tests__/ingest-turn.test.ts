import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { memoryItems, reminders, pendingActions, houseConfig, messages } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { reconcileFact } from '@/lib/memory/facts'
import { SAFE_VERDICT, type ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'
import type { TurnContext } from '@/lib/turn/context'
import type { GroundingItem } from '@/lib/ai/reply'
import { withSimulatedTime } from '@/lib/core/clock'

// The turn through the WHOLE ingest handler (docs/spec/chat-understanding-v2.md §1–§4): real origin,
// directedness, write-gate, capture, stores, retrieval (hybrid on PGlite), planner and executor —
// only the model calls and Telegram are mocked. Each block pins the CORRECT behaviour for a phase-1
// finding: what the reply model is handed (ctx, MODE, grounding) and what Baumy visibly does.

const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string, c?: unknown) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn(async (..._a: unknown[]) => ({ facts: [] as unknown[] }))
const extractReminderMock = vi.fn(async (..._a: unknown[]) => ({ isReminder: false, whenText: '', content: '' }))
const extractListMock = vi.fn(async (..._a: unknown[]) => ({ op: 'none', items: [] as string[] }))
const extractForgetMock = vi.fn(async (..._a: unknown[]) => ({ isForget: false, values: [] as string[], subject: '', attribute: '', permanent: false }))
const answerMock = vi.fn(async (_ctx: TurnContext, _mode: string, _g: GroundingItem[]) => ({ text: 'words', answered: true, usedTier: 'reply' }))
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const sendConfirmCard = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string, c?: unknown) => classifyMock(t, c) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (...a: unknown[]) => extractFactsMock(...a) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (...a: unknown[]) => extractReminderMock(...a) }))
vi.mock('@/lib/ai/list-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/list-extract')>()), extractListOp: (...a: unknown[]) => extractListMock(...a) }))
vi.mock('@/lib/ai/forget-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/forget-extract')>()), extractForget: (...a: unknown[]) => extractForgetMock(...a) }))
vi.mock('@/lib/ai/reply', async (o) => ({
  ...(await o<typeof import('@/lib/ai/reply')>()),
  answer: (ctx: TurnContext, mode: string, g: GroundingItem[]) => answerMock(structuredClone(ctx), mode, g),
}))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t), embedMany: async (ts: string[]) => ts.map((t) => actual.embedSync(t)) }
})
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, send: async () => ({ ids: [] }), createFunction: actual.inngest.createFunction.bind(actual.inngest) } }
})
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  sendConfirmCard: (...a: unknown[]) => sendConfirmCard(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumy_bot',
  getBotId: async () => 7001,
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')

const HOUSE = '-100turn'
const CHARLI = 810
const MARCO = 811
const TZ = 'Europe/Berlin'
// Mon 28 Sep 2026, 10:00 Berlin
const NOW = new Date('2026-09-28T08:00:00Z')
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

let uid = 0
const ev = (over: Partial<TelegramMessageData> = {}): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid,
    messageId: 100 + uid,
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
const run = (e: { data: TelegramMessageData }, s = step) => withSimulatedTime(NOW, () => runIngest(e, s))
const reactions = () => reactToMessage.mock.calls.map((c) => c[2])
const lastAnswer = () => {
  const c = answerMock.mock.calls.at(-1)
  if (!c) throw new Error('answer() was never called')
  return { ctx: c[0], mode: c[1], grounding: c[2] }
}

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  process.env.BAUMY_TIMEZONE = TZ
  process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64')
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  await upsertMember(dbh.db, HOUSE, String(MARCO), 'Marco', 'member')
  for (const m of [classifyMock, extractFactsMock, extractReminderMock, extractListMock, extractForgetMock, answerMock, sendToHouse, sendConfirmCard, reactToMessage]) m.mockClear()
  classifyMock.mockResolvedValue(V())
  extractFactsMock.mockResolvedValue({ facts: [] })
  extractReminderMock.mockResolvedValue({ isReminder: false, whenText: '', content: '' })
  extractListMock.mockResolvedValue({ op: 'none', items: [] })
  answerMock.mockResolvedValue({ text: 'words', answered: true, usedTier: 'reply' })
})

describe('the Charli bug (C1–C4, K2)', () => {
  const STATEMENT = 'Zuzka is staying in my room this weekend'
  const ZUZKA = { subject: 'zuzka', subjectKind: 'person', predicate: 'stays_in', object: "charli's room", objectKind: 'place', whenText: 'this weekend' }

  it('a directed statement gets an ACK in words, told who is speaking and what was noted — its own note/fact NOT in grounding', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    extractFactsMock.mockResolvedValue({ facts: [ZUZKA] })
    const res = await run(ev({ text: `@baumy_bot ${STATEMENT}` }))
    expect(res).toMatchObject({ directed: true, plan: 'words:ack', planRow: 'statement-directed' })
    const { ctx, mode, grounding } = lastAnswer()
    expect(mode).toBe('ack')
    expect(ctx.sender).toMatchObject({ name: 'Charli', firstName: 'Charli' })
    expect(ctx.text).toBe(STATEMENT)
    expect(ctx.outcome.captured?.learned).toEqual([expect.objectContaining({ subject: 'zuzka', object: "charli's room" })])
    expect(grounding).toEqual([]) // the message never grounds its own reply
    // words go out as a Telegram reply to the statement (C11)
    expect(sendToHouse).toHaveBeenCalledWith(HOUSE, 'words', expect.objectContaining({ replyToMessageId: 100 + uid }))
  })

  it('K2: "did you catch that?" restating it later is still an ack — the earlier fact grounds it, the restatement does not', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    extractFactsMock.mockResolvedValue({ facts: [ZUZKA] })
    await run(ev({ text: STATEMENT })) // undirected → ✍
    expect(reactions()).toEqual(['✍'])
    await run(ev({ text: `@baumy_bot did you catch that? ${STATEMENT}` }))
    const { mode, grounding } = lastAnswer()
    expect(mode).toBe('ack')
    // the ORIGINAL (a different, earlier note) may ground it — attributed to Charli, dated
    for (const g of grounding) {
      expect(g.who).toBe('Charli')
      expect(g.saidAt).toBeInstanceOf(Date)
    }
  })

  it('Marco’s later question is answered from Charli’s fact, attributed and dated (T1)', async () => {
    await withSimulatedTime(new Date('2026-09-24T17:00:00Z'), () =>
      reconcileFact(dbh.db, { groupId: HOUSE, fact: ZUZKA as never, authoredBy: String(CHARLI), trustLevel: 'untrusted', eventAt: new Date('2026-10-03T08:00:00Z') }),
    )
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', text: '@baumy_bot where is zuzka staying?' }))
    const { ctx, mode, grounding } = lastAnswer()
    expect(mode).toBe('answer')
    expect(ctx.sender.firstName).toBe('Marco')
    const fact = grounding.find((g) => g.kind === 'fact')!
    expect(fact).toMatchObject({ who: 'Charli', content: "zuzka stays in: charli's room" })
    expect(new Date(fact.saidAt!).toISOString()).toBe('2026-09-24T17:00:00.000Z')
  })

  it('an undirected statement never gets words or a 👎 — just ✍ when something was stored (C4)', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await run(ev({ text: 'the boiler guy comes tuesday' }))
    expect(answerMock).not.toHaveBeenCalled()
    expect(reactions()).toEqual(['✍'])
  })
})

describe('K3 / K5 — DMs', () => {
  it('K3: a DM statement gets a worded ack in the DM', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'the boiler service is on tuesday' }))
    expect(lastAnswer().mode).toBe('ack')
    expect(sendToHouse.mock.calls[0][0]).toBe(String(CHARLI))
  })
  it('K5: a DM question still gets an answer when triage returned a malformed object', async () => {
    classifyMock.mockResolvedValue(SAFE_VERDICT)
    const res = await run(ev({ chatId: String(MARCO), chatType: 'private', fromId: MARCO, fromFirstName: 'Marco', text: 'when is bin day?' }))
    expect(res).toMatchObject({ directed: true, directedWhy: 'dm', planRow: 'degraded-directed' })
    expect(lastAnswer().mode).toBe('answer')
    expect(await dbh.db.select().from(memoryItems)).toHaveLength(0) // I3: the degraded verdict stores nothing
  })
})

describe('I3 — questions are not evidence', () => {
  it('a question is never captured, so it can never ground a later answer as if it were a fact', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true, worthRemembering: true }))
    await run(ev({ text: '@baumy_bot is the plumber coming on thursday?' }))
    expect(await dbh.db.select().from(memoryItems)).toHaveLength(0)
    expect(lastAnswer().grounding).toEqual([]) // → the honest "nobody has mentioned that"
  })
  it('a degraded verdict on "forget my number 0176…" stores nothing', async () => {
    classifyMock.mockResolvedValue(SAFE_VERDICT)
    await run(ev({ text: 'baumy please forget my number 0176 5554433' }))
    expect(await dbh.db.select().from(memoryItems)).toHaveLength(0)
  })
})

describe('reminders — the outcome drives confirm / clarify (A2, A3, A9)', () => {
  const directedReminder = (whenText: string, content = 'take the bins out') => {
    classifyMock.mockResolvedValue(V({ intent: 'reminder', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText, content })
  }

  it('set → MODE confirm, THIS TURN carries the resolved time; the extractor was told the speaker', async () => {
    directedReminder('friday 8pm')
    const res = await run(ev({ text: '@baumy_bot remind us to take the bins out friday 8pm' }))
    expect(res).toMatchObject({ reminderSet: true, plan: 'words:confirm' })
    expect(extractReminderMock.mock.calls[0][1]).toBe('Charli')
    const { ctx, mode } = lastAnswer()
    expect(mode).toBe('confirm')
    expect(ctx.outcome.reminder).toMatchObject({ status: 'set', content: 'take the bins out' })
    expect(new Date((ctx.outcome.reminder as { fireAt: Date }).fireAt).toISOString()).toBe('2026-10-02T18:00:00.000Z') // Fri 2 Oct 20:00 Berlin
    expect(reactions()).not.toContain('👍') // the words ARE the confirmation
  })

  for (const [label, whenText, status] of [
    ['no time given', '', 'needs_time'],
    ['a time that cannot be read', 'when Zuzka lands', 'unparsed'],
    ['a time already past', 'yesterday at 9am', 'past'],
  ] as const) {
    it(`${label} → no reminder row, MODE clarify, outcome ${status}, never a ✍ or 👍`, async () => {
      directedReminder(whenText)
      const res = await run(ev({ text: `@baumy_bot remind us to take the bins out ${whenText}` }))
      expect(res.reminderSet).toBe(false)
      expect(await dbh.db.select().from(reminders)).toHaveLength(0)
      const { ctx, mode } = lastAnswer()
      expect(mode).toBe('clarify')
      expect(ctx.outcome.reminder).toMatchObject({ status })
      expect(reactions()).not.toContain('✍')
      expect(reactions()).not.toContain('👍')
    })
  }

  it('A9: an undirected "remind us" in the group creates nothing and says nothing', async () => {
    directedReminder('friday 8pm')
    const res = await run(ev({ text: 'remind me to text you about the van tomorrow' }))
    expect(extractReminderMock).not.toHaveBeenCalled()
    expect(await dbh.db.select().from(reminders)).toHaveLength(0)
    expect(res.planRow).toBe('reminder-undirected')
    expect(sendToHouse).not.toHaveBeenCalled()
    expect(reactToMessage).not.toHaveBeenCalled()
  })

  it('a DM reminder is directed (created, confirmed privately)', async () => {
    directedReminder('friday 8pm')
    await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'remind me friday 8pm to take the bins out' }))
    expect(await dbh.db.select().from(reminders)).toHaveLength(1)
    expect(lastAnswer().mode).toBe('confirm')
    expect(sendToHouse.mock.calls[0][0]).toBe(String(CHARLI))
  })
})

// A2/A3 follow-through: the clarifying question must be answerable. The open request is kept (a
// reminder draft) and the answer completes it — the extractor is shown the draft + Baumy's question.
describe('reminders — answering the clarifying question creates the reminder', () => {
  it('no time → clarify (draft kept) → "at 8pm" as a reply to Baumy → reminder row, MODE confirm', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'reminder', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: '', content: 'call the landlord' })
    await run(ev({ text: '@baumy_bot remind us to call the landlord' }))
    expect(lastAnswer().mode).toBe('clarify')
    expect(await dbh.db.select().from(pendingActions)).toHaveLength(1) // the draft

    // The answer: a reply to Baumy's question. Triage may call it anything — here plain chatter.
    classifyMock.mockResolvedValue(V({ intent: 'chatter' }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'at 8pm', content: '' })
    const res = await run(ev({ text: 'at 8pm', replyToMessage: { fromId: 7001, isBot: true, text: 'When should I remind you?', isTopicRoot: false } }))
    expect(extractReminderMock.mock.calls.at(-1)?.[2]).toEqual({ pending: 'call the landlord', baumyAsked: 'When should I remind you?' })
    expect(res).toMatchObject({ reminderSet: true, plan: 'words:confirm' })
    const rows = await dbh.db.select().from(reminders)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('call the landlord')
    expect(rows[0].fireAt.toISOString()).toBe('2026-09-28T18:00:00.000Z') // Mon 28 Sep 20:00 Berlin
    expect(lastAnswer().mode).toBe('confirm')
  })

  it('the draft is one-shot and only the requester can complete it', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'reminder', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: '', content: 'call the landlord' })
    await run(ev({ text: '@baumy_bot remind us to call the landlord' }))
    classifyMock.mockResolvedValue(V({ intent: 'chatter' }))
    extractReminderMock.mockClear()
    // Marco answering Charli's question does not take Charli's draft.
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', text: '8pm', replyToMessage: { fromId: 7001, isBot: true, text: 'When?', isTopicRoot: false } }))
    expect(extractReminderMock).not.toHaveBeenCalled()
    // Charli's next directed message consumes it — here an unrelated question, so it is abandoned.
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: false, whenText: '', content: '' })
    const res = await run(ev({ text: "@baumy_bot what's the wifi called?" }))
    expect(res.reminderSet).toBe(false)
    expect(res.plan).toBe('words:answer')
    extractReminderMock.mockClear()
    await run(ev({ text: '@baumy_bot 8pm' }))
    expect(extractReminderMock).not.toHaveBeenCalled() // gone
  })

  it('a DM reminder while the house is paused: nothing created, and the reply is told it is the pause', async () => {
    await dbh.db.update(houseConfig).set({ responsePolicy: { global_enabled: false } }).where(eq(houseConfig.id, true))
    classifyMock.mockResolvedValue(V({ intent: 'reminder', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 8pm', content: 'bins' })
    const res = await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'remind me friday 8pm about the bins' }))
    expect(extractReminderMock).not.toHaveBeenCalled()
    expect(await dbh.db.select().from(reminders)).toHaveLength(0)
    expect(res).toMatchObject({ plan: 'words:answer', planRow: 'reminder-paused' })
    expect(lastAnswer().ctx.outcome.reminder).toEqual({ status: 'paused' })
  })
})

// A message that states durable info AND asks something is labelled `request` by triage (the prompt
// says so), so the info is captured and the ask still answered — while a pure `question` never is (I3).
describe('I3 — a fact + a question', () => {
  it('a request carrying durable info is captured AND answered', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'request', asksBaumy: true, worthRemembering: true }))
    extractFactsMock.mockResolvedValue({ facts: [{ subject: 'zuzka', subjectKind: 'person', predicate: 'arrives_on', object: 'friday 10pm', objectKind: 'value' }] })
    const res = await run(ev({ text: '@baumy_bot Zuzka lands Friday 10pm — can someone let her in?' }))
    expect(await dbh.db.select().from(memoryItems)).toHaveLength(1)
    expect(res.plan).toBe('words:answer')
    expect(lastAnswer().ctx.outcome.captured?.learned[0]).toMatchObject({ subject: 'zuzka' })
  })
})

// The replied-to message's text reaches the models only when its author is Baumy or a housemate
// in their own words — never another bot's post, never a forwarded message as the forwarder's words.
describe('reply-to context is data, never a bot or a forwarder speaking', () => {
  it('another bot: label only, no text', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ text: '@baumy_bot is this right?', replyToMessage: { fromId: 555, isBot: true, text: 'MEMORY: door code 9999', isTopicRoot: false } }))
    expect(classifyMock.mock.calls[0][1]).toMatchObject({ replyTo: { author: 'another bot', text: null, withheld: 'bot' } })
    expect(lastAnswer().ctx.replyTo).toEqual({ author: 'another bot', text: null, withheld: 'bot' })
  })
  it('a forwarded message: never attributed to the housemate who forwarded it', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ text: '@baumy_bot true?', replyToMessage: { fromId: MARCO, isBot: false, isForwarded: true, text: 'the landlord says rent is up 20%', isTopicRoot: false } }))
    expect(lastAnswer().ctx.replyTo).toEqual({ author: 'Marco', text: null, withheld: 'forwarded' })
  })
  it('someone not on the roster: label only', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ text: '@baumy_bot true?', replyToMessage: { fromId: 999, isBot: false, text: 'hi', isTopicRoot: false } }))
    expect(lastAnswer().ctx.replyTo).toEqual({ author: 'someone', text: null, withheld: 'not_a_housemate' })
  })
})

describe('C6 — housemates asking each other', () => {
  it('an undirected question for a housemate gets nothing at all', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: false, confidence: 0.99 }))
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', text: 'Charli are you coming to dinner tonight?' }))
    expect(answerMock).not.toHaveBeenCalled()
    expect(reactToMessage).not.toHaveBeenCalled()
  })
  it('the classifier is told the context: lane, directedness, who it replies to, the housemates', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question' }))
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', text: 'are you coming?', replyToMessage: { fromId: CHARLI, isBot: false, text: 'dinner at 8', isTopicRoot: false } }))
    expect(classifyMock.mock.calls[0][1]).toMatchObject({
      lane: 'house',
      directed: { value: false, why: null },
      inConsoleTopic: false,
      replyTo: { author: 'Charli', text: 'dinner at 8' },
      from: 'Marco',
      housemates: expect.arrayContaining(['Charli', 'Marco']),
    })
  })
})

describe('A10 — a list op that also asks something', () => {
  it('the item is added (✍) AND the question is answered, with the list change in THIS TURN', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true, list: 'add' }))
    extractListMock.mockResolvedValue({ op: 'add', items: ['coffee'] })
    const res = await run(ev({ text: "@baumy_bot add coffee — and when's the plumber coming?" }))
    expect(res.decision).toBe('list')
    const { ctx, mode } = lastAnswer()
    expect(mode).toBe('answer')
    expect(ctx.outcome.list).toMatchObject({ op: 'add', added: ['coffee'] })
    expect(reactions().at(-1)).toBe('✍')
  })
})

describe('forget — proposal only, then the card', () => {
  it('a forget request with a matching fact sends a confirm card as a reply; nothing is deleted', async () => {
    await reconcileFact(dbh.db, { groupId: HOUSE, fact: { subject: 'charli', predicate: 'phone', object: '0176 5554433' }, authoredBy: String(CHARLI), trustLevel: 'untrusted' })
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    extractForgetMock.mockResolvedValue({ isForget: true, values: ['0176 5554433'], subject: '', attribute: '', permanent: false })
    await run(ev({ text: 'baumy forget my number 0176 5554433' }))
    expect(sendConfirmCard).toHaveBeenCalledTimes(1)
    expect(sendConfirmCard.mock.calls[0][4]).toBe(100 + uid) // reply_parameters → the request
    expect(await dbh.db.select().from(pendingActions)).toHaveLength(1)
    expect(await dbh.db.select().from(memoryItems)).toHaveLength(0) // a forget request is never captured
    expect(answerMock).not.toHaveBeenCalled()
  })
  // A1, the propose half: the pending action carries the HOUSE scope — the callback deletes in it —
  // never the chat the request came from (a DM chat, or a migrated supergroup's live id, owns no rows).
  it('a DM forget stores the HOUSE scope on the pending action, not the DM chat id', async () => {
    await reconcileFact(dbh.db, { groupId: HOUSE, fact: { subject: 'charli', predicate: 'phone', object: '0176 5554433' }, authoredBy: String(CHARLI), trustLevel: 'untrusted' })
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    extractForgetMock.mockResolvedValue({ isForget: true, values: ['0176 5554433'], subject: '', attribute: '', permanent: false })
    await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'forget my number 0176 5554433' }))
    const [pa] = await dbh.db.select().from(pendingActions)
    expect(pa.groupId).toBe(HOUSE)
    expect(sendConfirmCard.mock.calls[0][0]).toBe(String(CHARLI)) // the card goes to the DM
  })
  it('a forget from the migrated supergroup (live id ≠ scope) stores the scope', async () => {
    const LIVE = '-100turnlive'
    await dbh.db.update(houseConfig).set({ liveChatId: LIVE }).where(eq(houseConfig.id, true))
    await reconcileFact(dbh.db, { groupId: HOUSE, fact: { subject: 'charli', predicate: 'phone', object: '0176 5554433' }, authoredBy: String(CHARLI), trustLevel: 'untrusted' })
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    extractForgetMock.mockResolvedValue({ isForget: true, values: ['0176 5554433'], subject: '', attribute: '', permanent: false })
    await run(ev({ chatId: LIVE, text: 'baumy forget my number 0176 5554433' }))
    const [pa] = await dbh.db.select().from(pendingActions)
    expect(pa.groupId).toBe(HOUSE)
    expect(sendConfirmCard.mock.calls[0][0]).toBe(LIVE)
  })
  it('nothing to forget → the deterministic line, no pending action', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    extractForgetMock.mockResolvedValue({ isForget: true, values: ['nonexistent thing'], subject: '', attribute: '', permanent: false })
    await run(ev({ text: 'baumy forget the nonexistent thing' }))
    expect(String(sendToHouse.mock.calls[0][1])).toContain('nothing to forget')
    expect(await dbh.db.select().from(pendingActions)).toHaveLength(0)
  })
  it('paused house: no proposal is even created', async () => {
    await dbh.db.update(houseConfig).set({ responsePolicy: { global_enabled: false } }).where(eq(houseConfig.id, true))
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    extractForgetMock.mockResolvedValue({ isForget: true, values: ['x'], subject: '', attribute: '', permanent: false })
    await run(ev({ text: 'baumy forget x' }))
    expect(extractForgetMock).not.toHaveBeenCalled()
    expect(sendToHouse).not.toHaveBeenCalled()
  })
})

describe('exactly-once — the claim-and-release belt survives the refactor', () => {
  it('a retry after a failed send re-sends once; a replay after success never double-sends', async () => {
    const memo = new Map<string, unknown>()
    const memoStep: any = {
      run: async (id: string, fn: () => Promise<unknown>) => {
        if (memo.has(id)) return memo.get(id)
        const r = await fn()
        memo.set(id, r)
        return r
      },
    }
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    sendToHouse.mockRejectedValueOnce(new Error('telegram 502'))
    const e = ev({ text: '@baumy_bot when is bin day?' })
    await expect(run(e, memoStep)).rejects.toThrow('telegram 502')
    expect(reactions().at(-1)).toBeNull() // the stranded 👀 was cleared
    await run(e, memoStep) // Inngest retry: the claim was released, so it re-claims and sends
    expect(sendToHouse).toHaveBeenCalledTimes(2)
    await run({ data: { ...e.data } }, step) // a duplicate delivery with a fresh (non-memoized) step
    expect(sendToHouse).toHaveBeenCalledTimes(2) // claimReply refuses the second send
  })
})

describe('the conversation window (phase 2, spec §5 — C5)', () => {
  const windowRows = async () => (await dbh.db.select().from(messages).orderBy(messages.seq)) as (typeof messages.$inferSelect)[]

  it('every in-scope message is appended after lane resolution, and the next turn reads it (triage AND reply)', async () => {
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', text: "Zuzka's coming friday" }))
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ text: '@baumy_bot which room is she in?' }))
    const rows = await windowRows()
    expect(rows.map((r) => [r.authorKind, r.authorMemberId, r.authorName, r.trust, r.textRedacted])).toEqual([
      ['member', String(MARCO), 'Marco', 'untrusted', "Zuzka's coming friday"],
      ['member', String(CHARLI), 'Charli', 'untrusted', 'which room is she in?'], // the @mention stripped (C12)
    ])
    // The turn being answered is the MESSAGE, not a RECENT CHAT line.
    expect(lastAnswer().ctx.recent.map((t) => [t.author, t.text])).toEqual([['Marco', "Zuzka's coming friday"]])
    const triageCtx = classifyMock.mock.calls.at(-1)![1] as { recent: { turns: { text: string }[] } }
    expect(triageCtx.recent.turns.map((t) => t.text)).toEqual(["Zuzka's coming friday"])
  })

  it('never stores another bot’s post or an out-of-scope message; a forward is labelled and attributed to the forwarder only', async () => {
    await run(ev({ fromId: 5555, fromFirstName: 'PollBot', isBot: true, text: 'Poll: pizza or pasta?' }))
    await run(ev({ chatId: '-100elsewhere', text: 'hello from another group' }))
    await run(ev({ fromId: MARCO, fromFirstName: 'Marco', isForwarded: true, text: 'landlord: rent goes up 20%' }))
    const rows = await windowRows()
    expect(rows.map((r) => [r.trust, r.authorMemberId, r.textRedacted])).toEqual([['forwarded', String(MARCO), 'landlord: rent goes up 20%']])
  })

  it('an anonymous-admin post is house text with no attributable author (I8)', async () => {
    await run(ev({ fromId: 1087968824, fromFirstName: 'Group', fromUsername: 'GroupAnonymousBot', isBot: true, senderChatId: HOUSE, text: 'house meeting sunday' }))
    const [r] = await windowRows()
    expect(r).toMatchObject({ authorKind: 'anon', authorMemberId: null, trust: 'untrusted', textRedacted: 'house meeting sunday' })
  })

  it('a secret typed in chat is never persisted in the window', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    await run(ev({ text: 'the wifi password is hunter2 now' }))
    const rows = await windowRows()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('hunter2')
  })

  it('a forget request is withheld in the window (storing "forget X" would keep X around)', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'forget' }))
    await run(ev({ text: '@baumy_bot forget my number 0176 5550123' }))
    const [r] = await windowRows()
    expect(r.textRedacted).not.toContain('0176')
  })

  it('records what the message produced (the edit map, I1) — its evidence note and facts', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'statement', worthRemembering: true }))
    extractFactsMock.mockResolvedValue({ facts: [{ subject: 'boiler', subjectKind: 'thing', predicate: 'serviced_on', object: 'tuesday', objectKind: 'value', whenText: '' }] })
    await run(ev({ text: 'the boiler gets serviced tuesday' }))
    const [r] = await windowRows()
    const [note] = await dbh.db.select().from(memoryItems)
    expect(r.producedMemoryItemId).toBe(note.id)
    expect(r.producedFactIds).toHaveLength(1)
  })

  it('a DM is keyed to the DM chat: it never shows up in the group’s window', async () => {
    await run(ev({ chatId: String(MARCO), chatType: 'private', fromId: MARCO, fromFirstName: 'Marco', text: 'between us: I might move out' }))
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    await run(ev({ text: '@baumy_bot anything new?' }))
    expect(lastAnswer().ctx.recent).toEqual([])
    const [dm] = await windowRows()
    expect(dm).toMatchObject({ groupId: HOUSE, chatId: String(MARCO), trust: 'trusted' })
  })
})
