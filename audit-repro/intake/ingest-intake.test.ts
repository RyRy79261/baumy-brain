import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { memoryItems, reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { setConsoleThread } from '@/lib/identity/house'
import { retrieve } from '@/lib/memory/retrieve'
import { embedSync } from '@/lib/ai/embed'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

// AUDIT REPRO — intake / triage / gating / capture. Drives the REAL runIngest handler with a fake
// step + PGlite; only the LLM calls + Telegram transport are mocked. Each test documents a finding;
// assertions encode the CURRENT (buggy) behaviour so the test passes today and pins the mechanism.

const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn(async (_t: string, _s?: string | null) => ({ facts: [] as any[] }))
const extractReminderMock = vi.fn(async (_t: string) => ({ isReminder: false, whenText: '', content: '' }))
const answerMock = vi.fn(async (_q: string, _m: any[]) => ({ text: 'reply', answered: true }))
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (q: string, m: any[]) => answerMock(q, m) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/telegram/client', () => ({
  sendToHouse: (...a: unknown[]) => sendToHouse(...a),
  reactToMessage: (...a: unknown[]) => reactToMessage(...a),
  getBotUsername: async () => 'baumybot',
  sendConfirmCard: async () => {},
}))

const { runIngest } = await import('@/lib/inngest/functions/ingest')
const { classify: realClassify } = await vi.importActual<typeof import('@/lib/ai/classify')>('@/lib/ai/classify')

const HOUSE = '-100audit'
const CHARLI = 701
const MARCO = 702
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }

let uid = 1000
const ev = (over: Partial<TelegramMessageData> = {}): { data: TelegramMessageData } => {
  const id = ++uid
  return {
    data: {
      updateId: id,
      messageId: id,
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
      ...over,
    } as TelegramMessageData,
  }
}
const V = (over: Partial<ClassifierVerdict>): ClassifierVerdict => ({
  worthRemembering: false,
  intent: 'chatter',
  needsReply: false,
  confidence: 0.9,
  respond: 'ignore',
  reaction: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
  ...over,
})
const items = async () => dbh.db.select().from(memoryItems).where(eq(memoryItems.groupId, HOUSE))

describe('AUDIT intake/triage/capture', () => {
  beforeAll(() => {
    process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  })
  beforeEach(async () => {
    dbh.db = await makeTestDb()
    await ensureRegistered(dbh.db, HOUSE, null)
    await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
    await upsertMember(dbh.db, HOUSE, String(MARCO), 'Marco', 'member')
    for (const m of [classifyMock, extractFactsMock, extractReminderMock, answerMock, sendToHouse, reactToMessage]) m.mockClear()
    extractFactsMock.mockResolvedValue({ facts: [] })
    extractReminderMock.mockResolvedValue({ isReminder: false, whenText: '', content: '' })
    answerMock.mockResolvedValue({ text: 'reply', answered: true })
  })

  // A1/A4 — the motivating symptom. In the /baumyhere console topic EVERY message is `directed`, so
  // Charli's STATEMENT goes to answer() framed as a question, and — because capture runs first —
  // the grounding handed to the model contains Charli's own just-captured message, attributed to her.
  it('A1+A4: a statement in the console topic is answered with itself as grounding (quotes Charli back to Charli)', async () => {
    await setConsoleThread(dbh.db, 42)
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'fact', respond: 'react', reaction: '👍' }))
    const text = 'Zuzka is staying in my room this weekend'
    await runIngest(ev({ text, messageThreadId: 42 }), step)

    expect(answerMock).toHaveBeenCalledTimes(1)
    const [query, grounding] = answerMock.mock.calls[0]
    expect(query).toBe(text) // the statement is passed as the QUESTION
    // the message itself is in the grounding, attributed to the speaker
    const self = grounding.find((g: any) => g.content === text)
    expect(self).toBeTruthy()
    expect(self.authoredBy).toBe('Charli')
    expect(sendToHouse).toHaveBeenCalledTimes(1) // words posted to the group instead of a 🧠
  })

  // A1 — even a normal directed question retrieves ITSELF as grounding (captured before reply).
  it('A1/D15: a captured question grounds its own answer', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'question', respond: 'answer', needsReply: true }))
    const text = '@baumybot when is Zuzka arriving?'
    await runIngest(ev({ text, fromId: MARCO, fromFirstName: 'Marco' }), step)
    const [, grounding] = answerMock.mock.calls[0]
    expect(grounding.some((g: any) => g.content === text && g.authoredBy === 'Marco')).toBe(true)
    const [row] = await items()
    expect(row.memoryType).toBe('question') // stored as a memory, later retrievable as "info"
  })

  // D15 — a captured question/chatter is later retrieved as if it were house info (no memoryType filter).
  it('D15: an earlier QUESTION is returned by retrieval as grounding for a later question', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'question', respond: 'ignore' }))
    await runIngest(ev({ text: 'is the plumber coming on thursday?', fromId: MARCO, fromFirstName: 'Marco' }), step)
    const got = await retrieve('when is the plumber coming?', { groupId: HOUSE, k: 8, floor: 0.05 }, { db: dbh.db, embed: async (t) => embedSync(t) })
    expect(got.some((g) => g.content === 'is the plumber coming on thursday?' && g.memoryType === 'question')).toBe(true)
  })

  // D15 / SAFE_VERDICT — when triage fails, EVERYTHING is captured as 'chatter', including a
  // "forget X" request (the forget flow never runs, and the thing to forget is re-stored).
  it('SAFE_VERDICT: classifier failure captures a forget request verbatim and runs no forget flow', async () => {
    const safe = await realClassify('x', {} as any) // invalid model → generateObject throws → SAFE_VERDICT
    expect(safe).toMatchObject({ worthRemembering: true, intent: 'chatter', respond: 'ignore', confidence: 0.5 })
    classifyMock.mockResolvedValue(safe)
    const res = await runIngest(ev({ text: 'baumy please forget my number 0176 5554433' }), step)
    const rows = await items()
    expect(rows.map((r: any) => r.content)).toContain('baumy please forget my number 0176 5554433')
    expect(res.decision).toBe('capture') // decision is not 'forget' — the confirm-gated forget flow never runs
    // `directed` (short-name mention) routes to the REPLY path instead, answering as a question
    expect(answerMock).toHaveBeenCalledTimes(1)
  })

  // SAFE_VERDICT in a DM: a DM is NOT treated as directed, so a DM question during a triage
  // failure gets no reply at all (the comment on SAFE_VERDICT claims the directed path covers it).
  it('SAFE_VERDICT: a member DM question gets silence when triage fails', async () => {
    const safe = await realClassify('x', {} as any)
    classifyMock.mockResolvedValue(safe)
    const res = await runIngest(ev({ chatId: String(MARCO), chatType: 'private', fromId: MARCO, fromFirstName: 'Marco', text: 'when is bin day?' }), step)
    expect(res.directed).toBe(false)
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendToHouse).not.toHaveBeenCalled()
    expect((await items()).length).toBe(1) // but the question is stored as memory
  })

  // D16 — an edit re-runs the whole pipeline as a new message: duplicate note, duplicate reminder,
  // and the wrong original stays active (no supersede, contrary to spec D18).
  it('D16: editing a message duplicates the reminder and leaves the uncorrected note active', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'reminder', respond: 'react' }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 9am', content: 'bins out' })
    const first = ev({ text: 'remind us friday 9am bins out, cleaner comes monday' })
    await runIngest(first, step)
    // user fixes a typo in the same message → Telegram sends edited_message with a NEW update_id
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 9am', content: 'bins out' })
    await runIngest({ data: { ...first.data, updateId: first.data.updateId + 500, text: 'remind us friday 9am bins out, cleaner comes tuesday' } }, step)

    const rem = await dbh.db.select().from(reminders)
    expect(rem.length).toBe(2) // two "⏰ bins out" will fire
    const active = (await items()).filter((r: any) => r.isActive).map((r: any) => r.content)
    expect(active).toContain('remind us friday 9am bins out, cleaner comes monday') // wrong version still recallable
    expect(active).toContain('remind us friday 9am bins out, cleaner comes tuesday')
  })

  it('D16: editing a directed question produces a SECOND worded reply', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', respond: 'answer', needsReply: true }))
    const first = ev({ text: '@baumybot whats the bin day' })
    await runIngest(first, step)
    await runIngest({ data: { ...first.data, updateId: first.data.updateId + 500, text: "@baumybot what's the bin day?" } }, step)
    expect(sendToHouse).toHaveBeenCalledTimes(2)
  })

  // D17 — media captions / voice / location never reach ingest (text is null) → dropped as 'empty'.
  it('D17: a photo with a caption (text=null at ingest) is dropped before classify', async () => {
    const res = await runIngest(ev({ text: null as any }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'empty' })
    expect(classifyMock).not.toHaveBeenCalled()
  })

  // Forwarded content — a housemate forwarding the landlord's notice is quarantined: stored, gets a
  // 🧠 "I learned it" reaction, but no facts are extracted and retrieval never returns it.
  it('forwarded landlord notice: 🧠 acknowledged but never extractable or recallable', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'fact', respond: 'react', reaction: '👍' }))
    const text = 'Landlord: the boiler inspection is on Tuesday at 10am, please be home'
    await runIngest(ev({ text, isForwarded: true }), step)
    expect(extractFactsMock).not.toHaveBeenCalled()
    expect(reactToMessage).toHaveBeenCalledWith(HOUSE, expect.any(Number), '🧠')
    const [row] = await items()
    expect(row.trustLevel).toBe('quarantined')
    const got = await retrieve('when is the boiler inspection?', { groupId: HOUSE, k: 8, floor: 0.0 }, { db: dbh.db, embed: async (t) => embedSync(t) })
    expect(got.find((g) => g.content === text)).toBeUndefined()
  })

  // Anonymous-admin posts arrive with from=@GroupAnonymousBot (is_bot=true) → quarantined too.
  it('anonymous-admin message (from.is_bot) is quarantined and unattributed', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'fact', respond: 'react' }))
    await runIngest(ev({ text: 'the cleaner now comes on wednesdays', isBot: true, fromId: 1087968824, fromFirstName: 'Group' }), step)
    const [row] = await items()
    expect(row.trustLevel).toBe('quarantined')
    expect(row.authoredBy).toBeNull()
    expect(extractFactsMock).not.toHaveBeenCalled()
  })

  // A6 — prefilter runs before the directed check: "yes" as a reply to Baumy's question is dropped.
  it('A6: "yes" replying to Baumy is dropped as noise before directed/DM routing', async () => {
    const res = await runIngest(ev({ text: 'yes', replyToBot: true }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'noise' })
    const dm = await runIngest(ev({ chatId: String(MARCO), chatType: 'private', fromId: MARCO, text: 'no' }), step)
    expect(dm).toMatchObject({ decision: 'drop', reason: 'noise' })
  })

  // E20 — a reminder the classifier is only 0.65 "confident" about is silently NOT set, yet the
  // message is captured and gets 🧠, so the house believes it was handled.
  it('E20: reminder with classifier confidence 0.65 is silently not created but gets 🧠', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'reminder', respond: 'react', confidence: 0.65 }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'tomorrow 8am', content: 'put the bins out' })
    const res = await runIngest(ev({ text: 'remind us tomorrow 8am to put the bins out' }), step)
    expect(res.decision).toBe('capture')
    expect(extractReminderMock).not.toHaveBeenCalled()
    expect((await dbh.db.select().from(reminders)).length).toBe(0)
    expect(reactToMessage).toHaveBeenCalledWith(HOUSE, expect.any(Number), '🧠')
  })

  // E20 — needsReply has NO effect: respond=answer + needsReply=false still answers; the only
  // consumer (decide()'s 'reply' branch) is dead — no caller acts on decision==='reply'.
  it('E20: needsReply is ignored by routing', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', respond: 'answer', needsReply: false, confidence: 0.95 }))
    await runIngest(ev({ text: 'does anyone know when the landlord visits' }), step)
    expect(answerMock).toHaveBeenCalledTimes(1)
  })

  // New: a house-group slash command that isn't one of the 4 house commands (e.g. /pause, /help,
  // /dashboard typed in the group) falls through to classify + capture + possibly an LLM answer.
  it('group "/pause" is not handled as a command — it is classified and can be captured/answered', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'task', respond: 'answer' }))
    await runIngest(ev({ text: '/pause' }), step)
    expect(classifyMock).toHaveBeenCalledWith('/pause')
    expect((await items()).map((r: any) => r.content)).toContain('/pause')
    expect(answerMock).toHaveBeenCalled()
  })

  // New: a housemate the bot has not yet seen speak in the group (chat_member not delivered when
  // Baumy isn't admin) is 'ignore' in DMs — silently dropped with no feedback.
  it('unknown DM sender (new housemate not yet seen in group) is silently dropped', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', respond: 'answer' }))
    const res = await runIngest(ev({ chatId: '999', chatType: 'private', fromId: 999, fromFirstName: 'Newbie', text: 'what is the wifi password?' }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'out-of-scope' })
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  // New: near-verbatim restatement consolidation — a NEW occurrence ("cleaner is coming tomorrow"
  // said again weeks later, by someone else) folds onto the OLD note: old created_at, old author.
  it('consolidation folds a fresh restatement by another person onto the old note (old date, old author)', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'fact', respond: 'react' }))
    await runIngest(ev({ text: 'the cleaner is coming tomorrow' }), step)
    const [orig] = await items()
    await dbh.db.update(memoryItems).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(memoryItems.id, orig.id))
    await runIngest(ev({ text: 'the cleaner is coming tomorrow', fromId: MARCO, fromFirstName: 'Marco' }), step)
    const rows = await items()
    expect(rows.length).toBe(1)
    expect(rows[0].authoredBy).toBe(String(CHARLI))
    expect(new Date(rows[0].createdAt).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  // New: a QUESTION containing secret keywords is stored as a SECURE item; at reply time its
  // "decrypted secret" is the question text itself.
  it('a captured wifi-password QUESTION becomes a secure memory whose "secret" is the question', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'question', respond: 'ignore' }))
    await runIngest(ev({ text: "what's the wifi password again?", fromId: MARCO, fromFirstName: 'Marco' }), step)
    const [row] = await items()
    expect(row.isSecure).toBe(true)
    expect(row.content).toBe('the wifi password')
  })
  // New: a directed / "answer"-routed reminder request goes to the REPLY path, and answer() is never
  // told whether the reminder was actually created. REPLY_SYSTEM says "If they ALSO asked you to
  // remember/remind something, acknowledge that part" — so Baumy confirms reminders that do not exist.
  it('reminder request routed to reply: answer() gets no reminder outcome, even when none was set', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'reminder', respond: 'answer', confidence: 0.9 }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'when the landlord replies', content: 'chase the deposit' })
    await runIngest(ev({ text: '@baumybot can you remind us to chase the deposit when the landlord replies?' }), step)
    expect((await dbh.db.select().from(reminders)).length).toBe(0) // unparseable → no reminder
    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(answerMock.mock.calls[0].length).toBe(2) // (query, grounding) only — no reminderSet signal
    expect(reactToMessage).not.toHaveBeenCalledWith(HOUSE, expect.any(Number), '👍')
  })
})
