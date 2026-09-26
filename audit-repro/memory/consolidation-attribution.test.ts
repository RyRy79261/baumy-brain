// AUDIT REPRO (memory, F9 → phase 4): capture consolidation keeps the ORIGINAL timestamp + author.
// (Moved here from time/reports-capture.test.ts when phase 3 fixed that file's T2/T5 report repros —
// the correct report behaviour is pinned in lib/reports/__tests__/reports.test.ts.)
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered, captureMemory } = await import('@/lib/memory/write')
const { withSimulatedTime } = await import('@/lib/core/clock')
const { embedSync } = await import('@/lib/ai/embed')
const { memoryItems } = await import('@/db/schema')

const GROUP = '-100timerep'
const embed = async (t: string) => embedSync(t)

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
    // created_at is never bumped on consolidation:
    expect(rows[0].createdAt.getTime()).toBe(before.createdAt.getTime())
    expect(rows[0].createdAt.toISOString().startsWith('2026-12-01')).toBe(false)
  })
})
