// AUDIT REPRO (action flows: reminders). Real runIngest + PGlite; only the model transport,
// Voyage and Telegram are mocked. A PASSING test == the finding is confirmed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig, reminders } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, EXTRACT_REMINDER_SYSTEM } from '@/lib/ai/prompts'
import { parseWhen } from '@/lib/reminders/parse'
import { reminderExtraction } from '@/lib/ai/reminder-extract'
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
let reminderObj = { isReminder: true, whenText: '6pm', content: 'call the plumber' }

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
// A reminder request the classifier routes correctly (react, so the 👍 path — not the reply path).
const REM: ClassifierVerdict = {
  worthRemembering: true, intent: 'reminder', needsReply: false, confidence: 0.9, respond: 'react',
  reaction: null, tier: 'quick', webSearch: false, list: 'none',
}
const run = (e: { data: TelegramMessageData }) => withSimulatedTime(NOW.toJSDate(), () => runIngest(e, step))
const rows = async () => dbh.db.select().from(reminders)
const local = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).toFormat("ccc d LLL yyyy HH:mm")

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

describe('E18 — reminder content loses WHO', () => {
  it('the reminder extractor never sees the speaker; "remind me…" posts a nameless "⏰ call the plumber"', async () => {
    reminderObj = { isReminder: true, whenText: '6pm', content: 'call the plumber' }
    await run(ev({ text: 'remind me to call the plumber at 6pm' }))
    const p = prompts.find((c) => c.system === EXTRACT_REMINDER_SYSTEM)!
    expect(p.prompt).not.toMatch(/charli/i) // no SPEAKER line (contrast extractForget / extractFacts)
    const [r] = await rows()
    expect(r.content).toBe('call the plumber')
    // deliver it
    await reminderDeliver({ event: { data: { reminderId: r.id } }, step: { run: step.run, sleepUntil: async () => {} } })
    expect(resilientSend.mock.calls[0][1]).toBe('⏰ call the plumber') // whose job? nobody knows
  })

  it('a PERSONAL reminder set privately in a DM is broadcast to the house group', async () => {
    reminderObj = { isReminder: true, whenText: '9pm', content: 'take my antibiotics' }
    await run(ev({ chatId: String(CHARLI), chatType: 'private', text: 'remind me to take my antibiotics at 9pm' }))
    const [r] = await rows()
    expect(r.deliverChatId).toBe(HOUSE) // not Charli's DM
    await reminderDeliver({ event: { data: { reminderId: r.id } }, step: { run: step.run, sleepUntil: async () => {} } })
    expect(resilientSend.mock.calls[0][1]).toBe('⏰ take my antibiotics') // "my" now means nobody, in front of everyone
  })
})

describe('E19 — unparseable / missing time is dropped silently', () => {
  it('"remind us when Zuzka lands" → no reminder, no follow-up question, just a 🧠', async () => {
    reminderObj = { isReminder: true, whenText: 'when Zuzka lands', content: 'pick up Zuzka' }
    const res = await run(ev({ text: 'remind us to pick up Zuzka when she lands' }))
    expect(res.reminderSet).toBe(false)
    expect(await rows()).toHaveLength(0)
    expect(sendToHouse).not.toHaveBeenCalled()
    expect(reactToMessage.mock.calls.at(-1)?.[2]).toBe('🧠') // reads as "noted", reminder never exists
  })
  it('no time at all ("remind us to buy a birthday card for Marco") → whenText "" → dropped silently', async () => {
    reminderObj = { isReminder: true, whenText: '', content: 'buy a birthday card for Marco' }
    const res = await run(ev({ text: 'remind us to buy a birthday card for Marco' }))
    expect(res.reminderSet).toBe(false)
    expect(sendToHouse).not.toHaveBeenCalled()
  })
})

describe('time phrases the extractor is TOLD to produce are mis-resolved', () => {
  it('"Friday around 10pm" (EXTRACT_REMINDER_SYSTEM\'s own example) fires Friday 09:00 — time of day lost', async () => {
    reminderObj = { isReminder: true, whenText: 'Friday around 10pm', content: 'Zuzka arrives, let her in' }
    await run(ev({ text: 'remind us friday around 10pm to let Zuzka in' }))
    const [r] = await rows()
    expect(local(r.fireAt)).toBe('Fri 25 Sep 2026 09:00')
  })
  it('lead-time phrase "a week before friday" (reminder-extract.ts schema comment example) → a date in the PAST', () => {
    const p = parseWhen('a week before friday', TZ, NOW)!
    expect(local(p.fireAt)).toBe('Fri 18 Sep 2026 09:00')
    expect(p.fireAt.getTime()).toBeLessThan(NOW.toMillis())
  })
  it('a past fire time is accepted and delivered IMMEDIATELY (no past check at create, none in reminderDeliver)', async () => {
    reminderObj = { isReminder: true, whenText: '3 days before friday', content: 'the Friday party is in 3 days' }
    await run(ev({ text: 'remind us 3 days before friday that the party is coming' }))
    const [r] = await rows()
    expect(r.fireAt.getTime()).toBeLessThan(NOW.toMillis()) // Tue 22 Sep 09:00, i.e. yesterday
    expect(inngestSend).toHaveBeenCalled() // armed
    let slept: Date | null = null
    await reminderDeliver({ event: { data: { reminderId: r.id } }, step: { run: step.run, sleepUntil: async (_: string, d: Date) => { slept = d } } })
    expect(slept!.getTime()).toBeLessThan(NOW.toMillis()) // sleepUntil(past) = fire now
    expect(resilientSend).toHaveBeenCalledTimes(1)
  })
  it('"9/10" in a Berlin house (9 October) is read US-style → 10 September 2027', () => {
    expect(local(parseWhen('9/10', TZ, NOW)!.fireAt)).toBe('Fri 10 Sep 2027 09:00')
  })
})

describe('recurrence + multiplicity', () => {
  it('"every friday at 8pm" silently becomes ONE Friday; after delivery nothing re-arms', async () => {
    reminderObj = { isReminder: true, whenText: 'every friday at 8pm', content: 'bins out' }
    await run(ev({ text: 'remind us every friday at 8pm to put the bins out' }))
    const all = await rows()
    expect(all).toHaveLength(1)
    await reminderDeliver({ event: { data: { reminderId: all[0].id } }, step: { run: step.run, sleepUntil: async () => {} } })
    const after = await rows()
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('sent') // done forever; next Friday nothing
    expect(Object.keys(reminderExtraction.shape)).toEqual(['isReminder', 'whenText', 'content']) // no recurrence, no array
  })
})
