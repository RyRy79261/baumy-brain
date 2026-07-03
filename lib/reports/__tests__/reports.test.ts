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
const { parseHouseReport, weeklyReport, guestReport } = await import('@/lib/reports/reports')

const GROUP = '-100reports'
const embed = async (t: string) => embedSync(t)

describe('parseHouseReport', () => {
  it('detects /weekly + /guests, strips @bot, ignores everything else', () => {
    expect(parseHouseReport('/weekly')).toBe('weekly')
    expect(parseHouseReport('/guests please')).toBe('guests')
    expect(parseHouseReport('/guests@baumy_bot')).toBe('guests')
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
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'pay rent', fireAt: new Date(Date.now() + 3 * 86_400_000), createdBy: null })

    const out = await weeklyReport(db, GROUP)
    expect(out).toBe('REPORT OK')
    expect(captured.prompt).toContain('big party') // recent note is grounded
    expect(captured.prompt).toContain('pay rent') // upcoming reminder is grounded
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
