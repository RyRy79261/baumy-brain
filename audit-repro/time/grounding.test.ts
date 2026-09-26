// AUDIT REPRO (time/dates): what TIME information reaches the models that read house memory.
// Passing tests == the gap is present.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

const calls: { prompt?: string; system?: string }[] = []
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: async (args: { prompt?: string; system?: string }) => {
      calls.push(args)
      return { object: { reply: 'ok', answered: true, needsStrongerModel: false, facts: [] } }
    },
  }
})
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered } = await import('@/lib/memory/write')
const { reconcileFact, currentFactsForQuery } = await import('@/lib/memory/facts')
const { extractFacts } = await import('@/lib/ai/extract')
const { withSimulatedTime } = await import('@/lib/core/clock')
const { facts } = await import('@/db/schema')
const { runEventSurfacingScan } = await import('@/lib/inngest/functions/surfacing')

const GROUP = '-100time'
beforeEach(() => { calls.length = 0 })

// (B7/T1 "reply grounding carries no dates" fixed in phase 1: every MEMORY line now carries who said
// it and when, facts their event day — lib/ai/__tests__/reply.test.ts. What remains is the fact model.)
describe('B8/B9 — stored facts do not expire and keep relative wording', () => {
  it('a PAST event stays current and is still returned as a current fact (T2 → phase 3)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    // Captured in March, event resolved to 14 March.
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'place' },
        authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-14T08:00:00Z'),
      }),
    )
    // Six months later:
    const hits = await currentFactsForQuery(db, GROUP, 'is zuzka staying here?')
    expect(hits).toHaveLength(1)
    expect(hits[0].content).toBe("zuzka staying in: charli's room")
    const [row] = await db.select().from(facts).where(eq(facts.groupId, GROUP))
    expect(row.isCurrent).toBe(true) // never expires (B8)
  })

  it('B9 — a relative object ("tomorrow night") is stored verbatim and read back undated', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-09-01T18:00:00Z'), () =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'iman', subjectKind: 'person', predicate: 'arrives', object: 'tomorrow night' },
        authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-09-02T18:00:00Z'),
      }),
    )
    const hits = await currentFactsForQuery(db, GROUP, 'when does iman arrive')
    // The relative phrase is stored verbatim (T3 → phase 3); since phase 1 the reply at least sees the
    // said-on date + event day next to it, but the object itself still says "tomorrow night".
    expect(hits[0].content).toBe('iman arrives: tomorrow night')
  })
})

describe('extractor gets no message time', () => {
  it('EXTRACT prompt has SPEAKER + MESSAGE but no date, so object values cannot be absolutised', async () => {
    await withSimulatedTime(new Date('2026-09-26T10:00:00Z'), () => extractFacts('Zuzka arrives tomorrow night', 'Charli'))
    const { prompt, system } = calls[0]
    expect(prompt).toContain('SPEAKER: Charli')
    expect(prompt).not.toMatch(/2026|September|TODAY|today is/i)
    expect(system).not.toMatch(/September|TODAY is|today is/i)
  })
})

describe('NEW — a repeat visit is NOOPed and its new date is discarded', () => {
  it('same (subject, predicate, object) with a new eventAt -> noop; event_at keeps the OLD (past) date; no heads-up', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const fact = { subject: 'zuzka', subjectKind: 'person' as const, predicate: 'staying_in', object: "charli's room", objectKind: 'place' as const }
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      reconcileFact(db, { groupId: GROUP, fact, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-14T07:00:00Z') }),
    )
    // September: "Zuzka is staying in my room this weekend" again — a NEW visit on 3 Oct.
    const r = await withSimulatedTime(new Date('2026-09-28T18:00:00Z'), () =>
      reconcileFact(db, { groupId: GROUP, fact, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-10-03T07:00:00Z') }),
    )
    expect(r).toBe('noop') // -> learned=false too, so no 🧠
    const rows = await db.select().from(facts).where(eq(facts.groupId, GROUP))
    expect(rows).toHaveLength(1)
    expect(rows[0].eventAt?.toISOString()).toBe('2026-03-14T07:00:00.000Z')
    // The surfacing scan therefore never sees the October visit.
    const scan = await runEventSurfacingScan(db, GROUP, new Date('2026-09-29T06:00:00Z'), 'Europe/Berlin')
    expect(scan.scanned).toBe(0)
  })
})
