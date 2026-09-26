import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// AUDIT REPRO (spec-gap): spec prompt-mgmt.md persona — "Never claim you've ... scheduled ...
// unless the context says it actually happened" + "If a time is ambiguous, ask one short
// clarifying question". The reply prompt is never told whether the reminder step succeeded.
const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractReminderMock = vi.fn<(t: string) => Promise<{ isReminder: boolean; whenText: string; content: string }>>()
const replyCalls: { system: string; prompt: string }[] = []

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: async () => ({ facts: [] }) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/telegram/client', async (o) => ({ ...(await o<typeof import('@/lib/telegram/client')>()), getBotUsername: async () => 'baumybot' }))
vi.mock('ai', async (o) => {
  const actual = await o<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (args: { system: string; prompt: string }) => {
      replyCalls.push({ system: args.system, prompt: args.prompt })
      return { object: { reply: "on it, I'll remind everyone 😼", answered: true, needsStrongerModel: false } }
    },
  }
})

const { createSandbox, sendAs } = await import('@/lib/sandbox/harness')
const BASE: ClassifierVerdict = {
  worthRemembering: true, intent: 'reminder', needsReply: false, confidence: 0.9,
  respond: 'answer', reaction: null, tier: 'quick', webSearch: false, list: 'none',
}

describe('spec-gap: reply cannot know whether the reminder was actually set', () => {
  beforeEach(() => {
    replyCalls.length = 0
    classifyMock.mockReset().mockResolvedValue(BASE)
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('"can you remind us about the bins sometime?" — parse fails, no reminder row, yet the reply prompt carries no failure signal', async () => {
    dbh.db = await makeTestDb()
    const sb = await createSandbox({ db: dbh.db, startAt: new Date('2026-09-23T10:00:00Z'), people: [{ id: 1, name: 'Charli' }], tz: 'Europe/Berlin' })
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'sometime', content: 'take the bins out' })
    const out = await sendAs(sb, 'Charli', 'can you remind us about the bins sometime?')
    const rem = (await dbh.db.execute(sql`SELECT id FROM baumy_reminders`)) as any
    expect((Array.isArray(rem) ? rem : rem.rows).length).toBe(0) // nothing scheduled
    expect(replyCalls).toHaveLength(1)
    const p = replyCalls[0].prompt
    expect(p).not.toMatch(/reminder (set|scheduled|failed|not set)|could not parse|STATUS/i)
    // ...and the system prompt tells it to "acknowledge" the remind part — so it will say it's done.
    expect(replyCalls[0].system).toContain('ALSO asked you to remember/remind something, acknowledge that part')
    // the (mocked) model's success claim is sent verbatim to the house
    expect(JSON.stringify(out)).toContain("I'll remind everyone")
  })
})
