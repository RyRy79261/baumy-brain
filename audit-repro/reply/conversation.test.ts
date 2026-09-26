import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig } from '@/db/schema'
import { TRIAGE_SYSTEM, EXTRACT_FACTS_SYSTEM, EXTRACT_REMINDER_SYSTEM, REPLY_SYSTEM } from '@/lib/ai/prompts'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// AUDIT REPRO (reply/voice area): directed-ness, reply-to, follow-ups, reactions, and what the
// webhook forwards. Real runIngest + PGlite; only the model transport / Voyage / Telegram are mocked.

const dbh: { db: any } = { db: null }
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})
const inngestSend = vi.fn(async (..._a: unknown[]) => ({}))
type Call = { system: string; prompt: string }
const calls: Call[] = []
let triageVerdict: ClassifierVerdict
const reminderObject = { isReminder: true, whenText: 'when Zuzka lands', content: 'pick up Zuzka' }

vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (opts: { system: string; prompt: string }) => {
      calls.push({ system: opts.system, prompt: opts.prompt })
      if (opts.system === TRIAGE_SYSTEM) return { object: triageVerdict }
      if (opts.system === EXTRACT_FACTS_SYSTEM) return { object: { facts: [] } }
      if (opts.system === EXTRACT_REMINDER_SYSTEM) return { object: reminderObject }
      if (opts.system === REPLY_SYSTEM) return { object: { reply: "Got it, I'll remind you 👍", answered: true, needsStrongerModel: false } }
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
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, send: (...a: unknown[]) => inngestSend(...a), createFunction: actual.inngest.createFunction.bind(actual.inngest) } }
})

const { POST } = await import('@/app/api/telegram/webhook/route')

const HOUSE = '-100conv'
const CHARLI = 777
const MARCO = 778
const V: ClassifierVerdict = {
  intent: 'chatter',
  asksBaumy: false,
  worthRemembering: false,
  confidence: 0.9,
  vibe: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
}

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  process.env.TELEGRAM_WEBHOOK_SECRET = 'audit-secret-audit-secret-audit-secret'
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
  await upsertMember(dbh.db, HOUSE, String(MARCO), 'Marco', 'member')
  calls.length = 0
  sendToHouse.mockClear()
  reactToMessage.mockClear()
  inngestSend.mockClear()
  triageVerdict = V
})

async function postUpdate(update: unknown) {
  const req = new Request('http://x/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify(update),
  })
  const res = await POST(req)
  expect(res.status).toBe(200)
  return (inngestSend.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> } | undefined)?.data
}

describe('webhook: what reaches ingest', () => {
  it('an edited_message is forwarded as a brand-new telegram/message.received (new update id → full re-run)', async () => {
    const data = await postUpdate({
      update_id: 9002,
      edited_message: { message_id: 7, date: 0, edit_date: 1, chat: { id: -100123, type: 'supergroup' }, from: { id: CHARLI, is_bot: false, first_name: 'Charli' }, text: 'Zuzka arrives SATURDAY (not friday)' },
    })
    expect(data!.messageId).toBe(7)
    expect(Object.keys(data!)).not.toContain('isEdit')
  })

  it('a photo caption is dropped: text is null, so a captioned photo is prefiltered as empty', async () => {
    const data = await postUpdate({
      update_id: 9003,
      message: { message_id: 8, date: 0, chat: { id: -100123, type: 'supergroup' }, from: { id: CHARLI, is_bot: false, first_name: 'Charli' }, photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }], caption: '@baumy_bot this is the new bin schedule' },
    })
    expect(data!.text).toBeNull()
  })
})

// (Phase 1 fixed and removed the "directed-ness and follow-ups" repros: third-person mentions no
// longer count as directed (C10), the replied-to text reaches the reply prompt as REPLYING TO (C5),
// housemate-to-housemate questions get no Baumy reply (C6), and the reply model is told the reminder
// outcome (A3). Correct behaviour: lib/pipeline/__tests__/directed.test.ts, lib/turn/__tests__/
// plan.test.ts, scenarios/routing + reminders. Phase 2 fixed the rest of C5 — the recent-chat window
// with Baumy's own replies: lib/turn/__tests__/window.test.ts, scenarios/window.)
