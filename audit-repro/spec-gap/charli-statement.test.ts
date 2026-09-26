import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import { setConsoleThread } from '@/lib/identity/house'

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
  worthRemembering: false, intent: 'chatter', needsReply: false, confidence: 0.9,
  respond: 'ignore', reaction: null, tier: 'quick', webSearch: false, list: 'none',
}
// What triage plausibly returns for an informative statement (worth remembering, 'react').
const FACT: ClassifierVerdict = { ...BASE, worthRemembering: true, intent: 'fact', respond: 'react', reaction: '👍' }
// ...and what it returns when it errs toward 'answer' ("When unsure ... ANSWER").
const FACT_ANSWER: ClassifierVerdict = { ...FACT, respond: 'answer' }

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

describe('spec-gap: a directed STATEMENT is answered as a QUESTION, grounded on itself, with no speaker', () => {
  beforeEach(() => {
    replyCalls.length = 0
    classifyMock.mockReset().mockResolvedValue(FACT)
    extractFactsMock.mockReset().mockResolvedValue({ facts: [ZUZKA_FACT] })
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('addressing Baumy by name with a statement → reply prompt frames it as QUESTION, MEMORY holds the same message, no SENDER', async () => {
    const sb = await fresh()
    await sendAs(sb, 'Charli', `baumy ${STATEMENT}`)

    expect(replyCalls).toHaveLength(1) // the reply path DID fire for a pure statement
    const { prompt, system } = replyCalls[0]
    // A3: framed as a QUESTION
    expect(prompt).toContain(`QUESTION (data): baumy ${STATEMENT}`)
    // A1: the message being replied to is already in MEMORY (captured before reply) — as a note
    //     AND as the fact distilled from it, both attributed "from Charli".
    expect(prompt).toMatch(/\(chatter|fact, from Charli\)/)
    expect(prompt).toContain(`from Charli) ${`baumy ${STATEMENT}`}`)
    expect(prompt).toContain("zuzka staying in: charli's room")
    // A2 / spec prompt-mgmt.md:14,201: no SENDER / house_context / members / reminders block
    expect(prompt).not.toMatch(/SENDER|house_context|Members|<reminders>|incoming_message/)
    // The only place "Charli" appears is inside MEMORY attributions — never as the speaker.
    const beforeMemory = prompt.split('MEMORY:')[0]
    expect(beforeMemory).not.toContain('Charli')
    const questionLine = prompt.split('QUESTION (data):')[1]
    expect(questionLine).not.toContain('Charli')
    // B7 / spec prompt-mgmt.md:205: memory lines carry no timestamp ([isoTs | from X])
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    // System prompt tells it to "Answer the QUESTION" — no acknowledge-a-statement mode.
    expect(system).toContain('Answer the QUESTION')
    expect(system).not.toMatch(/statement|acknowledg(e|ing) (a|the) (statement|update|news)/i)
  })

  it('in the /baumyhere console topic, an un-addressed statement also goes to the QUESTION path', async () => {
    const sb = await fresh()
    await setConsoleThread(dbh.db, 77)
    // sandbox sendAs cannot set messageThreadId; drive runIngest directly
    const { runIngest } = await import('@/lib/inngest/functions/ingest')
    const { captureOutbound } = await import('@/lib/telegram/outbox')
    const { withSimulatedTime } = await import('@/lib/core/clock')
    const step = { run: async <T>(_i: string, fn: () => Promise<T>) => fn() }
    await captureOutbound(() =>
      withSimulatedTime(sb.now, () =>
        runIngest({ data: { updateId: 9001, messageId: 9001, chatId: sb.houseChatId, chatType: 'supergroup', fromId: 701, fromFirstName: 'Charli', fromLastName: null, fromUsername: null, text: STATEMENT, isBot: false, isForwarded: false, replyToBot: false, messageThreadId: 77 } as any }, step),
      ),
    )
    expect(replyCalls).toHaveLength(1)
    expect(replyCalls[0].prompt).toContain(`QUESTION (data): ${STATEMENT}`)
    expect(replyCalls[0].prompt).toContain(`from Charli) ${STATEMENT}`)
  })

  it('a member DM statement the classifier marks respond=answer is answered as a QUESTION (and grounded on itself)', async () => {
    const sb = await fresh()
    classifyMock.mockResolvedValue(FACT_ANSWER)
    await sendAs(sb, 'Charli', STATEMENT, { dm: true })
    expect(replyCalls).toHaveLength(1)
    expect(replyCalls[0].prompt).toContain(`QUESTION (data): ${STATEMENT}`)
    expect(replyCalls[0].prompt).toContain(`from Charli) ${STATEMENT}`)
  })

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
