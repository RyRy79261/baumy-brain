import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// AUDIT REPRO (spec-gap sweep). Drives the REAL ingest pipeline (sandbox harness) with the REAL
// reply builder (lib/ai/reply.ts groundedReply). Only the network edges are mocked: classify,
// extractFacts, embeddings, and the AI-SDK generateObject call (captured so we can inspect the
// exact prompt the reply model receives).

const dbh: { db: any } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn<(t: string, s?: string | null) => Promise<{ facts: unknown[] }>>()
const replyCalls: { system: string; prompt: string }[] = []

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) }
})
vi.mock('@/lib/telegram/client', async (o) => ({
  ...(await o<typeof import('@/lib/telegram/client')>()),
  getBotUsername: async () => 'baumybot',
}))
vi.mock('ai', async (o) => {
  const actual = await o<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (args: { system: string; prompt: string }) => {
      replyCalls.push({ system: args.system, prompt: args.prompt })
      return { object: { reply: 'I don’t know, Charli said Zuzka will be staying', answered: true, needsStrongerModel: false } }
    },
  }
})

const { createSandbox, sendAs } = await import('@/lib/sandbox/harness')

const BASE: ClassifierVerdict = {
  intent: 'chatter', asksBaumy: false, worthRemembering: false, confidence: 0.9, vibe: null, tier: 'quick', webSearch: false, list: 'none',
}
// What triage returns for an informative statement.
const FACT: ClassifierVerdict = { ...BASE, worthRemembering: true, intent: 'statement' }

const PEOPLE = [
  { id: 701, name: 'Charli', role: 'owner' as const },
  { id: 702, name: 'Marco' },
]
const STATEMENT = 'Zuzka is staying in my room this weekend'
const ZUZKA_FACT = { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'place', whenText: 'this weekend' }

async function fresh() {
  dbh.db = await makeTestDb()
  return createSandbox({ db: dbh.db, startAt: new Date('2026-09-23T10:00:00Z'), people: PEOPLE, tz: 'Europe/Berlin' })
}

describe('spec-gap: Baumy has no memory of its own side of the conversation (C5 → phase 2)', () => {
  beforeEach(() => {
    replyCalls.length = 0
    classifyMock.mockReset().mockResolvedValue(FACT)
    extractFactsMock.mockReset().mockResolvedValue({ facts: [ZUZKA_FACT] })
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  // (Phase 1 fixed and removed: a directed / console-topic / DM statement framed as a QUESTION,
  // grounded on itself, with no SENDER and no dates (C1–C4, T1). Correct behaviour: scenarios/charli
  // + routing, lib/ai/__tests__/reply.test.ts. Still open — the conversation window is phase 2:)
  it("A5/D15: Baumy's own reply is never stored, so a follow-up has no conversational context", async () => {
    const sb = await fresh()
    await sendAs(sb, 'Charli', `baumy ${STATEMENT}`)
    const rows = (await dbh.db.execute(sql`SELECT content, authored_by FROM baumy_memory_items`)) as any
    const list = (Array.isArray(rows) ? rows : rows.rows) as { content: string; authored_by: string | null }[]
    // only Charli's inbound message is in memory; Baumy's reply text is nowhere
    expect(list.map((r) => r.content)).toEqual([`baumy ${STATEMENT}`])
    expect(list.some((r) => /Charli said/.test(r.content))).toBe(false)
  })
})
