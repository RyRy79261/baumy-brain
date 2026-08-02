import { describe, it, expect, vi } from 'vitest'

let captured: { prompt?: string; system?: string } = {}
const genText = vi.fn(async (args: { prompt?: string; system?: string }) => {
  captured = args
  return { text: 'REPORT OK' }
})
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: (...a: unknown[]) => genText(a[0] as never) }
})
// Keep retrieval offline (no Voyage/network); the fact-graph paths are exercised via PGlite.
vi.mock('@/lib/memory/retrieve', () => ({ retrieve: vi.fn(async () => []) }))

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered, captureMemory } = await import('@/lib/memory/write')
const { reconcileFact } = await import('@/lib/memory/facts')
const { createReminder } = await import('@/lib/reminders/store')
const { embedSync } = await import('@/lib/ai/embed')
const { parseHouseReport, weeklyReport, guestReport, upcomingRemindersReport, recentLearningsReport } = await import('@/lib/reports/reports')

const GROUP = '-100reports'
const embed = async (t: string) => embedSync(t)

describe('parseHouseReport', () => {
  it('detects /weekly + /guests + /reminders + /recent, strips @bot, ignores everything else', () => {
    expect(parseHouseReport('/weekly')).toBe('weekly')
    expect(parseHouseReport('/guests please')).toBe('guests')
    expect(parseHouseReport('/guests@baumy_bot')).toBe('guests')
    expect(parseHouseReport('/reminders')).toBe('reminders')
    expect(parseHouseReport('/recent@baumy_bot')).toBe('recent')
    expect(parseHouseReport('/weeklyish')).toBeNull()
    expect(parseHouseReport('who are the guests')).toBeNull()
    expect(parseHouseReport(null)).toBeNull()
  })
})

describe('weeklyReport', () => {
  it('grounds the digest in recent notes + upcoming reminders + today', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await captureMemory({ groupId: GROUP, content: 'we threw a big party on saturday', memoryType: 'chatter', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'take the bins out', fireAt: new Date(Date.now() + 3 * 86_400_000), createdBy: null })

    const out = await weeklyReport(db, GROUP)
    expect(out).toBe('REPORT OK')
    expect(captured.prompt).toContain('big party') // recent note is grounded
    expect(captured.prompt).toContain('take the bins out') // upcoming reminder is grounded
    expect(captured.prompt).toContain('TODAY:') // clock for relative dates
    expect(captured.system).toContain('WEEKLY HOUSE DIGEST')
  })

  it('says it is quiet (no model call) when there is nothing on file', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    expect(await weeklyReport(db, GROUP)).toMatch(/quiet/i)
  })
})

describe('guestReport', () => {
  it('grounds on stay/room facts (who is in which room)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'staying_in', object: 'the cave' }, authoredBy: null, trustLevel: 'untrusted' })

    const out = await guestReport(db, GROUP)
    expect(out).toBe('REPORT OK')
    expect(captured.prompt).toContain('zuzana')
    expect(captured.prompt).toContain('the cave')
    expect(captured.system).toContain('UPCOMING GUESTS')
  })

  it('says the house is guest-free (no model call) when nothing is on the books', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    expect(await guestReport(db, GROUP)).toMatch(/guest-free|all yours/i)
  })
})

describe('upcomingRemindersReport (introspection — deterministic, no model)', () => {
  it('lists scheduled future reminders in fire order, ⏰ explicit vs 🗓️ event heads-up', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'call the landlord', fireAt: new Date(Date.now() + 2 * 86_400_000), createdBy: null })
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'zuzka arrives', fireAt: new Date(Date.now() + 5 * 86_400_000), anchorKind: 'event_offset', createdBy: null })

    genText.mockClear() // shared spy — check THIS call makes no model request
    const out = await upcomingRemindersReport(db, GROUP, 'Europe/Berlin')
    expect(out).toContain('⏰ call the landlord')
    expect(out).toContain('🗓️ zuzka arrives')
    expect(out.indexOf('landlord')).toBeLessThan(out.indexOf('zuzka')) // ordered by fire time
    expect(genText).not.toHaveBeenCalled() // deterministic — no LLM
  })

  it('ignores past reminders and says all-clear when nothing is scheduled', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'old thing', fireAt: new Date(Date.now() - 86_400_000), createdBy: null })
    expect(await upcomingRemindersReport(db, GROUP, 'Europe/Berlin')).toMatch(/all clear|nothing/i)
  })
})

describe('recentLearningsReport (introspection — deterministic, secret-safe)', () => {
  it('lists recent non-secret facts but NEVER a secret value', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'the bins', subjectKind: 'thing', predicate: 'go_out_on', object: 'tuesday' }, authoredBy: null, trustLevel: 'untrusted' })
    // "the wifi password S3cretPass" matches the wifi-password pattern → auto-secured (is_secure=true,
    // object_value nulled + encrypted), so the read-out must exclude it entirely.
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'the wifi', subjectKind: 'thing', predicate: 'password', object: 'S3cretPass' }, authoredBy: null, trustLevel: 'untrusted' })

    genText.mockClear()
    const out = await recentLearningsReport(db, GROUP)
    expect(out).toContain('bins')
    expect(out).toContain('tuesday')
    expect(out).not.toContain('S3cretPass') // the bulk read-out can never dump a secret value
    expect(out).not.toContain('wifi') // the secret fact is omitted whole, not just its value
    expect(genText).not.toHaveBeenCalled() // deterministic — no LLM
  })

  it('says nothing-new when there are no facts on file', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    expect(await recentLearningsReport(db, GROUP)).toMatch(/haven't picked up|nothing/i)
  })
})
