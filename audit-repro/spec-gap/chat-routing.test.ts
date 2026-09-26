import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// AUDIT REPRO (spec-gap sweep): deterministic routing divergences from docs/spec.
const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn<(t: string, s?: string | null) => Promise<{ facts: unknown[] }>>()
const extractReminderMock = vi.fn<(t: string) => Promise<{ reminders: { content: string; whenText?: string; fireAt?: string }[] }>>()
const answerMock = vi.fn<(...a: unknown[]) => Promise<{ text: string; answered: boolean }>>()

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (...a: unknown[]) => answerMock(...a) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/telegram/client', async (o) => ({ ...(await o<typeof import('@/lib/telegram/client')>()), getBotUsername: async () => 'baumybot' }))

const { createSandbox } = await import('@/lib/sandbox/harness')
const { runIngest } = await import('@/lib/inngest/functions/ingest')
const { captureOutbound } = await import('@/lib/telegram/outbox')
const { withSimulatedTime } = await import('@/lib/core/clock')

const BASE: ClassifierVerdict = {
  intent: 'chatter', asksBaumy: false, worthRemembering: false, confidence: 0.9, vibe: null, tier: 'quick', webSearch: false, list: 'none',
}
const PEOPLE = [{ id: 701, name: 'Charli', role: 'owner' as const }, { id: 702, name: 'Theo' }]

async function fresh() {
  dbh.db = await makeTestDb()
  return createSandbox({ db: dbh.db, startAt: new Date('2026-09-23T10:00:00Z'), people: PEOPLE, tz: 'Europe/Berlin' })
}

describe('spec-gap: deterministic chat routing', () => {
  beforeEach(() => {
    for (const m of [classifyMock, extractFactsMock, extractReminderMock, answerMock]) m.mockReset()
    classifyMock.mockResolvedValue(BASE)
    extractFactsMock.mockResolvedValue({ facts: [] })
    extractReminderMock.mockResolvedValue({ reminders: [] })
    answerMock.mockResolvedValue({ text: 'ok!', answered: true })
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('D16 / spec telegram.md:47, llm-pipeline.md:696: an EDIT re-runs as a brand-new message (duplicate note + duplicate reply), no supersede', async () => {
    const sb = await fresh()
    classifyMock.mockResolvedValue({ ...BASE, worthRemembering: true, intent: 'question', asksBaumy: true, confidence: 0.95 })
    const step = { run: async <T>(_i: string, fn: () => Promise<T>) => fn() }
    const ev = (updateId: number, text: string) => ({ data: { updateId, messageId: 42, chatId: sb.houseChatId, chatType: 'supergroup', fromId: 701, fromFirstName: 'Charli', fromLastName: null, fromUsername: null, text, isBot: false, isForwarded: false, replyToBot: false } as any })
    const a = await captureOutbound(() => withSimulatedTime(sb.now, () => runIngest(ev(1, 'baumy when does Zuzka arrive on friday?'), step)))
    // Telegram delivers the edit as a NEW update_id with the SAME message_id; webhook forwards it identically.
    const b = await captureOutbound(() => withSimulatedTime(sb.now, () => runIngest(ev(2, 'baumy when does Zuzka arrive on saturday?'), step)))
    const words = [...a.sent, ...b.sent].filter((m: any) => m.kind === 'message' || m.text)
    expect(answerMock).toHaveBeenCalledTimes(2) // answered twice for one logical message
    // (A question is no longer captured as evidence — I3 — so the duplicate-NOTE half of D16 is pinned by
    // audit-repro/intake/ingest-intake.test.ts on a statement instead.)
    expect(words.length).toBeGreaterThanOrEqual(2)
  })

  // (Phase 1 fixed and removed: the un-directed "someone remind everyone…" reminder (A9) and the
  // A4/C4 statement-routed-to-answer / 👎-on-news repros — see scenarios/reminders + routing.)
})
