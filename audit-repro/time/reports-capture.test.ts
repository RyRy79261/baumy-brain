// AUDIT REPRO (time/dates): /guests, /weekly and capture consolidation lose WHEN things were said.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

const prompts: string[] = []
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: async (a: { prompt: string }) => { prompts.push(a.prompt); return { text: 'REPORT' } } }
})
vi.mock('@/lib/memory/retrieve', () => ({ retrieve: vi.fn(async () => []) }))
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered, captureMemory } = await import('@/lib/memory/write')
const { reconcileFact } = await import('@/lib/memory/facts')
const { withSimulatedTime } = await import('@/lib/core/clock')
const { embedSync } = await import('@/lib/ai/embed')
const { memoryItems } = await import('@/db/schema')
const { guestReport, weeklyReport } = await import('@/lib/reports/reports')

const GROUP = '-100timerep'
const embed = async (t: string) => embedSync(t)
beforeEach(() => { prompts.length = 0 })

describe('B8/B10 — reports', () => {
  it('/guests: a guest whose stay ended months ago is fed to the model as current, with no date', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'place' },
        authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-14T08:00:00Z'),
      }),
    )
    await guestReport(db, GROUP, new Date('2026-09-26T10:00:00Z'))
    const p = prompts[0]
    expect(p).toContain("zuzka staying in: charli's room")
    expect(p).not.toMatch(/Mar|2026-03|14/) // no event date, no recorded date -> model reports Zuzka as an upcoming guest
  })

  it('/weekly: "recent" notes are the 20 newest rows with NO timestamps and include questions/chatter', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-06-01T10:00:00Z'), async () => {
      await captureMemory({ groupId: GROUP, content: 'the party is tomorrow night', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
      await captureMemory({ groupId: GROUP, content: 'is the party still on?', memoryType: 'question', authoredBy: null, trustLevel: 'untrusted' }, { db, embed })
    })
    await weeklyReport(db, GROUP, new Date('2026-09-26T10:00:00Z'))
    const p = prompts[0]
    expect(p).toContain('- noted: the party is tomorrow night') // months old, read as "tomorrow" relative to TODAY
    expect(p).toContain('- noted: is the party still on?') // a question presented as a noted fact
    expect(p).not.toMatch(/2026-06|June/)
  })
})

describe('NEW — capture consolidation keeps the ORIGINAL timestamp + author', () => {
  it('a verbatim restatement months later by someone else is folded onto the old note (created_at + authored_by unchanged)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100, 'Marco')
    await ensureRegistered(db, GROUP, 200, 'Charli')
    const first = await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      captureMemory({ groupId: GROUP, content: 'Zuzka is staying in the cave this weekend', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' }, { db, embed }),
    )
    const [before] = await db.select().from(memoryItems).where(eq(memoryItems.id, first))
    const second = await withSimulatedTime(new Date('2026-12-01T10:00:00Z'), () =>
      captureMemory({ groupId: GROUP, content: 'Zuzka is staying in the cave this weekend', memoryType: 'fact', authoredBy: '200', trustLevel: 'untrusted' }, { db, embed }),
    )
    expect(second).toBe(first)
    const rows = await db.select().from(memoryItems).where(eq(memoryItems.groupId, GROUP))
    expect(rows).toHaveLength(1)
    expect(rows[0].authoredBy).toBe('100') // Charli's new statement is attributed to Marco
    // created_at is never bumped on consolidation (and is a DB default, blind to the sim clock):
    expect(rows[0].createdAt.getTime()).toBe(before.createdAt.getTime())
    expect(rows[0].createdAt.toISOString().startsWith('2026-12-01')).toBe(false)
  })
})
