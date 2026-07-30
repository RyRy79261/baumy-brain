import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { reminders } from '@/db/schema'
import { createReminder } from '@/lib/reminders/store'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { embedSync } from '@/lib/ai/embed'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// A whole house, driven end-to-end: people talk, time moves, Baumy acts. The LLM calls are mocked
// (offline suite) but EVERYTHING else is the real production path — origin resolution, the trust
// wall, capture, fact reconciliation, the surfacing scan, the digest and its staleness window.

const dbh: { db: Awaited<ReturnType<typeof makeTestDb>> | null } = { db: null }
const classifyMock = vi.fn<(t: string) => Promise<ClassifierVerdict>>()
const extractFactsMock = vi.fn<(t: string, s?: string | null) => Promise<{ facts: unknown[] }>>()
const extractReminderMock = vi.fn<(t: string) => Promise<{ isReminder: boolean; whenText: string; content: string }>>()
const answerMock = vi.fn<(q: string) => Promise<{ text: string; answered: boolean }>>()
const writeHeadsUpMock = vi.fn<(f: { subject: string }[], lead: string, when: string) => Promise<string | null>>()

vi.mock('@/db/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
vi.mock('@/lib/ai/classify', async (o) => ({ ...(await o<typeof import('@/lib/ai/classify')>()), classify: (t: string) => classifyMock(t) }))
vi.mock('@/lib/ai/extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/extract')>()), extractFacts: (t: string, s?: string | null) => extractFactsMock(t, s) }))
vi.mock('@/lib/ai/reminder-extract', async (o) => ({ ...(await o<typeof import('@/lib/ai/reminder-extract')>()), extractReminder: (t: string) => extractReminderMock(t) }))
vi.mock('@/lib/ai/reply', async (o) => ({ ...(await o<typeof import('@/lib/ai/reply')>()), answer: (q: string) => answerMock(q) }))
vi.mock('@/lib/ai/nudge', async (o) => ({ ...(await o<typeof import('@/lib/ai/nudge')>()), writeHeadsUp: (...a: [{ subject: string }[], string, string]) => writeHeadsUpMock(...a) }))
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t) } // deterministic, offline
})

const { createSandbox, sendAs, advanceTo, advanceBy, spoken } = await import('@/lib/sandbox/harness')

// Real verdict shape — worthRemembering is what gates capture, so a fixture missing it silently
// disables the whole memory path (it did, first time round).
const CHATTER: ClassifierVerdict = {
  worthRemembering: false,
  intent: 'chatter',
  needsReply: false,
  confidence: 0.9,
  respond: 'ignore',
  reaction: null,
  tier: 'quick',
  webSearch: false,
  list: 'none',
}
const FACT: ClassifierVerdict = { ...CHATTER, worthRemembering: true, intent: 'fact', respond: 'react' }
const REMINDER: ClassifierVerdict = { ...CHATTER, worthRemembering: true, intent: 'reminder', respond: 'react' }
const QUESTION: ClassifierVerdict = { ...CHATTER, intent: 'question', respond: 'answer', needsReply: true, confidence: 0.95 }

const PEOPLE = [
  { id: 501, name: 'Madeleine', role: 'owner' as const },
  { id: 502, name: 'Charl' },
  { id: 503, name: 'Ryan' },
]

async function freshSandbox(startAt: string) {
  const db = await makeTestDb()
  dbh.db = db
  return createSandbox({ db, startAt: new Date(startAt), people: PEOPLE, tz: 'Europe/Berlin' })
}

describe('sandbox — talk as anyone, move time, watch what happens', () => {
  beforeEach(() => {
    for (const m of [classifyMock, extractFactsMock, extractReminderMock, answerMock, writeHeadsUpMock]) m.mockReset()
    classifyMock.mockResolvedValue(CHATTER)
    extractFactsMock.mockResolvedValue({ facts: [] })
    extractReminderMock.mockResolvedValue({ isReminder: false, whenText: '', content: '' })
    answerMock.mockResolvedValue({ text: 'meow', answered: true })
    writeHeadsUpMock.mockResolvedValue(null)
    process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('a message from a housemate becomes a dated fact, which becomes a heads-up, which the digest posts a week later', async () => {
    const sb = await freshSandbox('2026-07-01T09:00:00Z')

    // Madeleine mentions an arrival. The classifier flags a fact; extraction dates it.
    classifyMock.mockResolvedValue(FACT)
    extractFactsMock.mockResolvedValue({
      facts: [{ subject: 'zuzana', subjectKind: 'person', predicate: 'arrives_on', object: '8 July', whenText: '8 July' }],
    })
    await sendAs(sb, 'Madeleine', "zuzana's arriving on the 8th, she'll take the cave")

    // Nothing is said to the group yet — capture is quiet, by design.
    expect(spoken(sb.transcript)).toEqual([])

    // The model would write the heads-up line; here we pin it so the assertion is about plumbing.
    writeHeadsUpMock.mockResolvedValue('Zuzana lands tomorrow and is taking the cave')

    // Move to the morning of the 7th: the 08:00 scan schedules the day-before nudge, and the same
    // morning's digest is too early for it (it fires at 08:00 on the 7th, i.e. the NEXT slot).
    const week = await advanceTo(sb, new Date('2026-07-07T12:00:00Z'))
    expect(week.fired.map((f) => f.job)).toContain('surfacing-scan')

    const scheduled = await sb.db.select().from(reminders).where(eq(reminders.groupId, sb.houseChatId))
    expect(scheduled.length).toBeGreaterThan(0)
    expect(scheduled.every((r: { anchorKind: string }) => r.anchorKind === 'event_offset')).toBe(true)

    // …and by the 8th the digest has actually posted it to the group.
    const arrival = await advanceTo(sb, new Date('2026-07-08T18:00:00Z'))
    const said = arrival.fired.flatMap((f) => spoken(f.said))
    expect(said.join('\n')).toContain('Zuzana lands tomorrow')
    expect(said.join('\n')).toContain('🗓️') // heads-up framing, not an ⏰ alarm
  })

  it('an explicit "remind us" from one person fires at its time — and each job runs at ITS OWN instant, not all at the end', async () => {
    const sb = await freshSandbox('2026-07-01T09:00:00Z')
    classifyMock.mockResolvedValue(REMINDER)
    extractReminderMock.mockResolvedValue({ isReminder: true, whenText: '3 July at 9am', content: 'bins go out' })
    await sendAs(sb, 'Charl', 'remind us to put the bins out on the 3rd at 9am')

    // Jump a WEEK in one call. The reminder must land on the 3rd's digest, not be flushed at the
    // destination timestamp — that difference is the whole reason jobs run at their own `now`.
    const res = await advanceBy(sb, { days: 7 })
    const firing = res.fired.find((f) => spoken(f.said).some((t) => t.includes('bins go out')))
    expect(firing).toBeDefined()
    expect(firing!.at.toISOString().slice(0, 10)).toBe('2026-07-03')
    expect(spoken(firing!.said)[0]).toContain('⏰') // explicit reminder framing
  })

  it('a backlog that accrued while nothing ran is RETIRED, not flushed into the group', async () => {
    // The failure the house actually saw: reminders sat undelivered (a paused cron, a deploy gap),
    // then the next digest posted months-old news. Note that stepping through time NORMALLY does
    // deliver on time — this models the crons NOT having run, by seeding a past-due row directly.
    const sb = await freshSandbox('2026-07-01T09:00:00Z')
    await createReminder(sb.db, {
      groupId: sb.houseChatId,
      deliverChatId: sb.houseChatId,
      content: 'let them in when they return',
      fireAt: new Date('2026-05-20T09:00:00Z'), // six weeks before the sandbox even starts
      createdBy: null,
    })

    const res = await advanceTo(sb, new Date('2026-07-02T09:00:00Z'))
    const everythingSaid = res.fired.flatMap((f) => spoken(f.said)).join('\n')
    expect(everythingSaid).not.toContain('let them in')

    const [row] = await sb.db.select().from(reminders).where(eq(reminders.groupId, sb.houseChatId))
    expect(row.status).toBe('cancelled') // retired, audited — not delivered
  })

  it('the trust wall still holds inside the sandbox: forwarded content is quarantined, never a fact', async () => {
    const sb = await freshSandbox('2026-07-01T09:00:00Z')
    classifyMock.mockResolvedValue(FACT)
    extractFactsMock.mockResolvedValue({ facts: [{ subject: 'the boiler', predicate: 'code_is', object: '9999' }] })

    await sendAs(sb, 'Ryan', 'FORWARDED: the boiler code is 9999', { forwarded: true })

    // Quarantined origin ⇒ extractFacts is never even called, so nothing can be planted by
    // forwarding a message into the house. The sandbox exercises the REAL wall, not a copy of it.
    expect(extractFactsMock).not.toHaveBeenCalled()
  })

  it('runs as different people, and a DM is a different lane from the group', async () => {
    const sb = await freshSandbox('2026-07-01T09:00:00Z')
    classifyMock.mockResolvedValue(QUESTION)
    answerMock.mockResolvedValue({ text: 'the cave is free', answered: true })

    const group = await sendAs(sb, 'Charl', 'is the cave free?')
    const dm = await sendAs(sb, 'Ryan', 'is the cave free?', { dm: true })

    // Group answer goes to the house; the DM answer goes back to that member's private chat only.
    expect(group.filter((e) => e.kind === 'message').map((e) => e.chatId)).toEqual([sb.houseChatId])
    expect(dm.filter((e) => e.kind === 'message').map((e) => e.chatId)).toEqual(['503'])
  })

  it('never touches the real Telegram API — capture is enforced in the transport', async () => {
    // If the sink were not installed, sendToHouse would try to construct a grammY Api and throw on
    // the missing token. Getting a transcript back at all is the proof.
    delete process.env.TELEGRAM_BOT_TOKEN
    const sb = await freshSandbox('2026-07-01T09:00:00Z')
    classifyMock.mockResolvedValue(QUESTION)
    answerMock.mockResolvedValue({ text: 'meow', answered: true })
    const said = await sendAs(sb, 'Madeleine', 'you there?')
    expect(spoken(said)).toEqual(['meow'])
  })
})

// The clock seam itself, in isolation — the property everything above depends on.
describe('simulated time is scoped, not global', () => {
  it('now() is the wall clock outside a sandbox and pinned inside one', async () => {
    const { now, withSimulatedTime, isSimulated } = await import('@/lib/core/clock')
    const fake = new Date('2001-01-01T00:00:00Z')
    expect(isSimulated()).toBe(false)
    const real = now()
    withSimulatedTime(fake, () => {
      expect(now().toISOString()).toBe(fake.toISOString())
      expect(isSimulated()).toBe(true)
    })
    // …and it does not leak out of the call tree.
    expect(isSimulated()).toBe(false)
    expect(now().getTime()).toBeGreaterThanOrEqual(real.getTime())
  })
})

// embedSync is imported for its side-effect-free determinism; referenced so lint sees the use.
void embedSync
