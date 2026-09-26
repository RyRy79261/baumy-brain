import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { memoryItems, reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
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
const answerMock = vi.fn(async (..._a: unknown[]) => ({ text: 'reply', answered: true }))
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
const reactToMessage = vi.fn(async (..._a: unknown[]) => {})

vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (...a: unknown[]) => answerMock(...a) }))
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
  intent: 'chatter',
  asksBaumy: false,
  worthRemembering: false,
  confidence: 0.9,
  vibe: null,
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

  // (Phase 1 fixed and removed: A1/A4 self-grounded console statement, A1/D15 captured questions,
  // SAFE_VERDICT capture-everything + DM silence (I3/K5), E20 confidence-gated reminders + needsReply
  // (I6), and the reply blind to the reminder outcome (A3) — the correct behaviour is pinned in
  // lib/turn/__tests__/plan.test.ts, lib/inngest/functions/__tests__/ingest-turn.test.ts and scenarios/.)

  // D16 — an edit re-runs the whole pipeline as a new message: duplicate note, duplicate reminder,
  // and the wrong original stays active (no supersede, contrary to spec D18).
  it('D16: editing a message duplicates the reminder and leaves the uncorrected note active', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'reminder', asksBaumy: true }))
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 9am', content: 'bins out' })
    const first = ev({ text: '@baumybot remind us friday 9am bins out, cleaner comes monday' })
    await runIngest(first, step)
    // user fixes a typo in the same message → Telegram sends edited_message with a NEW update_id
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: 'friday 9am', content: 'bins out' })
    await runIngest({ data: { ...first.data, updateId: first.data.updateId + 500, text: '@baumybot remind us friday 9am bins out, cleaner comes tuesday' } }, step)

    const rem = await dbh.db.select().from(reminders)
    expect(rem.length).toBe(2) // two "⏰ bins out" will fire
    const active = (await items()).filter((r: any) => r.isActive).map((r: any) => r.content)
    expect(active).toContain('remind us friday 9am bins out, cleaner comes monday') // wrong version still recallable
    expect(active).toContain('remind us friday 9am bins out, cleaner comes tuesday')
  })

  it('D16: editing a directed question produces a SECOND worded reply', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
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

  // Forwarded content — a housemate forwarding the landlord's notice is quarantined: stored, but no
  // facts are extracted and retrieval never returns it (I5/D4 → phase 5). (Phase 1: no misleading ✍
  // "noted" on it any more — the planner gives quarantined content no voice.)
  it('forwarded landlord notice: stored but never extractable or recallable', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'statement' }))
    const text = 'Landlord: the boiler inspection is on Tuesday at 10am, please be home'
    await runIngest(ev({ text, isForwarded: true }), step)
    expect(extractFactsMock).not.toHaveBeenCalled()
    const [row] = await items()
    expect(row.trustLevel).toBe('quarantined')
    const got = await retrieve('when is the boiler inspection?', { groupId: HOUSE, k: 8, floor: 0.0 }, { db: dbh.db, embed: async (t) => embedSync(t) })
    expect(got.find((g) => g.content === text)).toBeUndefined()
  })

  // New: a housemate the bot has not yet seen speak in the group (chat_member not delivered when
  // Baumy isn't admin) is 'ignore' in DMs — silently dropped with no feedback.
  it('unknown DM sender (new housemate not yet seen in group) is silently dropped', async () => {
    classifyMock.mockResolvedValue(V({ intent: 'question', asksBaumy: true }))
    const res = await runIngest(ev({ chatId: '999', chatType: 'private', fromId: 999, fromFirstName: 'Newbie', text: 'what is the wifi password?' }), step)
    expect(res).toMatchObject({ decision: 'drop', reason: 'out-of-scope' })
    expect(sendToHouse).not.toHaveBeenCalled()
  })

  // New: near-verbatim restatement consolidation — a NEW occurrence ("cleaner is coming tomorrow"
  // said again weeks later, by someone else) folds onto the OLD note: old created_at, old author.
  it('consolidation folds a fresh restatement by another person onto the old note (old date, old author)', async () => {
    classifyMock.mockResolvedValue(V({ worthRemembering: true, intent: 'statement' }))
    await runIngest(ev({ text: 'the cleaner is coming tomorrow' }), step)
    const [orig] = await items()
    await dbh.db.update(memoryItems).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(memoryItems.id, orig.id))
    await runIngest(ev({ text: 'the cleaner is coming tomorrow', fromId: MARCO, fromFirstName: 'Marco' }), step)
    const rows = await items()
    expect(rows.length).toBe(1)
    expect(rows[0].authoredBy).toBe(String(CHARLI))
    expect(new Date(rows[0].createdAt).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
