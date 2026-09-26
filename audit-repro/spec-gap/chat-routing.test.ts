import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import { prefilter } from '@/lib/pipeline/prefilter'

// AUDIT REPRO (spec-gap sweep): deterministic routing divergences from docs/spec.
const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn<(t: string, s?: string | null) => Promise<{ facts: unknown[] }>>()
const extractReminderMock = vi.fn<(t: string) => Promise<{ isReminder: boolean; whenText: string; content: string }>>()
const answerMock = vi.fn<(q: string) => Promise<{ text: string; answered: boolean }>>()

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (q: string) => answerMock(q) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/telegram/client', async (o) => ({ ...(await o<typeof import('@/lib/telegram/client')>()), getBotUsername: async () => 'baumybot' }))

const { createSandbox, sendAs } = await import('@/lib/sandbox/harness')
const { runIngest } = await import('@/lib/inngest/functions/ingest')
const { captureOutbound } = await import('@/lib/telegram/outbox')
const { withSimulatedTime } = await import('@/lib/core/clock')

const BASE: ClassifierVerdict = {
  worthRemembering: false, intent: 'chatter', needsReply: false, confidence: 0.9,
  respond: 'ignore', reaction: null, tier: 'quick', webSearch: false, list: 'none',
}
const PEOPLE = [{ id: 701, name: 'Charli', role: 'owner' as const }, { id: 702, name: 'Theo' }]
const rowsOf = (r: any) => (Array.isArray(r) ? r : r.rows) as any[]

async function fresh() {
  dbh.db = await makeTestDb()
  return createSandbox({ db: dbh.db, startAt: new Date('2026-09-23T10:00:00Z'), people: PEOPLE, tz: 'Europe/Berlin' })
}

describe('spec-gap: deterministic chat routing', () => {
  beforeEach(() => {
    for (const m of [classifyMock, extractFactsMock, extractReminderMock, answerMock]) m.mockReset()
    classifyMock.mockResolvedValue(BASE)
    extractFactsMock.mockResolvedValue({ facts: [] })
    extractReminderMock.mockResolvedValue({ isReminder: false, whenText: '', content: '' })
    answerMock.mockResolvedValue({ text: 'ok!', answered: true })
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('A6: "yes"/"no" sent as a REPLY TO BAUMY is dropped by the prefilter before the directed check', async () => {
    expect(prefilter('yes').keep).toBe(false)
    expect(prefilter('no').keep).toBe(false)
    const sb = await fresh()
    const out = await sendAs(sb, 'Charli', 'yes', { replyToBot: true })
    expect(out).toEqual([]) // Baumy asked e.g. "want me to remind the house?" — the answer vanishes
    expect(classifyMock).not.toHaveBeenCalled()
  })

  it('D16 / spec telegram.md:47, llm-pipeline.md:696: an EDIT re-runs as a brand-new message (duplicate note + duplicate reply), no supersede', async () => {
    const sb = await fresh()
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'question', respond: 'answer', needsReply: true, confidence: 0.95 })
    const step = { run: async <T>(_i: string, fn: () => Promise<T>) => fn() }
    const ev = (updateId: number, text: string) => ({ data: { updateId, messageId: 42, chatId: sb.houseChatId, chatType: 'supergroup', fromId: 701, fromFirstName: 'Charli', fromLastName: null, fromUsername: null, text, isBot: false, isForwarded: false, replyToBot: false } as any })
    const a = await captureOutbound(() => withSimulatedTime(sb.now, () => runIngest(ev(1, 'baumy when does Zuzka arrive on friday?'), step)))
    // Telegram delivers the edit as a NEW update_id with the SAME message_id; webhook forwards it identically.
    const b = await captureOutbound(() => withSimulatedTime(sb.now, () => runIngest(ev(2, 'baumy when does Zuzka arrive on saturday?'), step)))
    const words = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'message' || m.text)
    expect(answerMock).toHaveBeenCalledTimes(2) // answered twice for one logical message
    const notes = rowsOf(await dbh.db.execute(sql`SELECT content, is_active FROM baumy_memory_items WHERE is_active = true`))
    expect(notes.length).toBe(2) // both the original and the edit are live evidence — nothing superseded
    expect(words.length).toBeGreaterThanOrEqual(2)
  })

  it('spec product.md transcript (b): an UN-directed "someone remind everyone ..." must NOT create a reminder — code creates one', async () => {
    const sb = await fresh()
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'reminder', respond: 'react', confidence: 0.9 })
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 8pm', content: 'clear the front room' })
    await sendAs(sb, 'Theo', 'someone remind everyone to clear the front room Friday night')
    const rem = rowsOf(await dbh.db.execute(sql`SELECT content FROM baumy_reminders`))
    expect(rem.map((r) => r.content)).toEqual(['clear the front room'])
  })

  it('A4: a statement that is a reply to ANY Baumy message is "directed" → routed to answer() as a question', async () => {
    const sb = await fresh()
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'fact', respond: 'react', confidence: 0.9 })
    await sendAs(sb, 'Charli', 'Zuzka is staying in my room this weekend', { replyToBot: true })
    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(answerMock.mock.calls[0][0]).toBe('Zuzka is staying in my room this weekend')
  })

  it('A4: an undirected statement mis-triaged respond=answer with a weak memory hit gets a 👎 (a dismissive reaction to someone TELLING Baumy something)', async () => {
    const sb = await fresh()
    // earlier chatter so grounding is non-empty
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'chatter', confidence: 0.9 })
    await sendAs(sb, 'Theo', 'Zuzka might visit at some point')
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'fact', respond: 'answer', confidence: 0.9 })
    answerMock.mockResolvedValue({ text: "I don't have that", answered: false })
    const out = await sendAs(sb, 'Charli', 'Zuzka is staying in my room this weekend')
    const reacts = out.filter((m: any) => JSON.stringify(m).includes('👎'))
    expect(reacts.length).toBe(1)
  })
})
