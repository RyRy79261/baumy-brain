// AUDIT REPRO (action flows: reminders). Real runIngest + PGlite; only the model transport,
// Voyage and Telegram are mocked. A PASSING test == the finding is confirmed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig, reminders } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, EXTRACT_REMINDER_SYSTEM } from '@/lib/ai/prompts'
import { withSimulatedTime } from '@/lib/core/clock'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import type { TelegramMessageData } from '@/lib/inngest/client'

const dbh: { db: any } = { db: null }
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})
const inngestSend = vi.fn(async (..._a: unknown[]) => ({}))
const resilientSend = vi.fn(async (..._a: unknown[]) => {})
const prompts: { system: string; prompt: string }[] = []
let triage: ClassifierVerdict
let reminderObj: { reminders: { content: string; whenText?: string; fireAt?: string; forWhom?: 'speaker' | 'house' }[] } = { reminders: [] }

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (opts: { system: string; prompt: string }) => {
      prompts.push({ system: opts.system, prompt: opts.prompt })
      if (opts.system === TRIAGE_SYSTEM) return { object: triage }
      if (opts.system === EXTRACT_FACTS_SYSTEM) return { object: { facts: [] } }
      if (opts.system === EXTRACT_REMINDER_SYSTEM) return { object: reminderObj }
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
vi.mock('@/lib/telegram/house-send', () => ({ sendToHouseResilient: (...a: unknown[]) => resilientSend(...a) }))
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, send: (...a: unknown[]) => inngestSend(...a), createFunction: (_a: unknown, _b: unknown, h: unknown) => h } }
})

const { runIngest } = await import('@/lib/inngest/functions/ingest')
const { reminderDeliver } = (await import('@/lib/inngest/functions/reminders')) as unknown as {
  reminderDeliver: (ctx: { event: { data: { reminderId: string } }; step: unknown }) => Promise<unknown>
}

const HOUSE = '-100actrem'
const CHARLI = 777
const TZ = 'Europe/Berlin'
// Wednesday 23 Sep 2026, 10:30 Berlin
const NOW = DateTime.fromISO('2026-09-23T10:30:00', { zone: TZ })
const step: any = { run: (_id: string, fn: () => Promise<unknown>) => fn() }
let uid = 0
const ev = (over: Partial<TelegramMessageData>): { data: TelegramMessageData } => ({
  data: {
    updateId: ++uid, messageId: uid, chatId: HOUSE, chatType: 'supergroup', fromId: CHARLI,
    fromFirstName: 'Charli', fromLastName: null, fromUsername: null, text: 'x',
    isBot: false, isForwarded: false, replyToBot: false, ...over,
  },
})
// A reminder request the classifier routes correctly. Group texts below are @-addressed: since
// phase 1 an UNDIRECTED "remind us" creates nothing (A9), so the repros need a directed ask.
const REM: ClassifierVerdict = {
  intent: 'reminder', asksBaumy: true, worthRemembering: true, confidence: 0.9, vibe: null, tier: 'quick', webSearch: false, list: 'none',
}
const run = (e: { data: TelegramMessageData }) => withSimulatedTime(NOW.toJSDate(), () => runIngest(e, step))
const rows = async () => dbh.db.select().from(reminders)

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  process.env.BAUMY_TIMEZONE = TZ
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  prompts.length = 0
  sendToHouse.mockClear(); reactToMessage.mockClear(); inngestSend.mockClear(); resilientSend.mockClear()
  triage = REM
})

// (Phase 3 fixed and removed: E18/A4 nameless "remind me" content, T4 "friday around 10pm" / lead
// times / "9/10", and A6 recurrence + several reminders per message — the correct behaviour is pinned
// in lib/inngest/functions/__tests__/ingest-turn.test.ts, lib/reminders/__tests__/digest.test.ts,
// lib/core/__tests__/when.test.ts and scenarios/time.scenario.test.ts.)

describe('A5 — a personal DM reminder goes to the whole house (phase 5, D2)', () => {
  it('a PERSONAL reminder set privately in a DM is broadcast to the house group', async () => {
    reminderObj = { reminders: [{ content: 'take my antibiotics', whenText: '9pm', fireAt: '', forWhom: 'speaker' }] }
    await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'remind me to take my antibiotics at 9pm' }))
    const [r] = await rows()
    expect(r.deliverChatId).toBe(HOUSE) // not Charli's DM
    await withSimulatedTime(r.fireAt, () =>
      reminderDeliver({ event: { data: { reminderId: r.id } }, step: { run: step.run, sleepUntil: async () => {}, sendEvent: async () => {} } }),
    )
    // Since phase 3 it at least names her (A4) — but it still posts in front of everyone.
    expect(resilientSend.mock.calls[0][1]).toBe('⏰ Charli: take my antibiotics')
  })
})
