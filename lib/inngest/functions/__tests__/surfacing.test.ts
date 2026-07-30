import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import type { HeadsUpFact, HeadsUpLead } from '@/lib/ai/nudge'

const GROUP = '-100surf'
const TZ = 'Europe/Berlin'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

// The heads-up LINE is written by the model — mocked here (offline suite), so what these tests
// prove is the deterministic half: WHICH events are eligible, how facts group into one nudge, the
// dedupe, and that a SKIP schedules nothing.
const writeHeadsUp = vi.fn<(f: HeadsUpFact[], lead: HeadsUpLead, when: string) => Promise<string | null>>()
vi.mock('@/lib/ai/nudge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/nudge')>()
  return { ...actual, writeHeadsUp: (...a: Parameters<typeof writeHeadsUp>) => writeHeadsUp(...a) }
})
const { runEventSurfacingScan } = await import('@/lib/inngest/functions/surfacing')

const eventReminders = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  db.select().from(reminders).where(eq(reminders.groupId, GROUP))

describe('event-surfacing scan — dated facts become event-anchored reminders', () => {
  beforeEach(() => {
    writeHeadsUp.mockReset()
    writeHeadsUp.mockImplementation(async (facts, lead) => `${facts.map((f) => f.subject).join(' + ')} — ${lead}`)
  })

  it('schedules the three lead nudges once, and never re-schedules them (dedup per event×stage)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-01T09:00:00Z')
    const eventAt = new Date('2026-07-08T12:00:00Z') // ~7 days out, inside the horizon
    // reconcileFact storing event_at is Part 1 under test here too — the scan can only see it
    // because capture now persists the resolved date.
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'arrives_on', object: '8 July' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt,
    })

    const r1 = await runEventSurfacingScan(db, GROUP, now, TZ)
    expect(r1).toEqual({ created: 3, scanned: 1, skipped: 0 })
    const rows = await eventReminders(db)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.anchorKind === 'event_offset')).toBe(true) // heads-up, delivered as 🗓️
    expect(rows.every((r) => r.eventFactId != null)).toBe(true) // anchored to the fact for dedup
    // the model wrote each line — code passed it the lead + the fact's own words, not a template
    expect(rows.some((r) => r.content.includes('next week'))).toBe(true)
    expect(rows.some((r) => r.content.includes('tomorrow'))).toBe(true)
    expect(writeHeadsUp.mock.calls[0][0]).toEqual([
      { subject: 'zuzana', predicate: 'arrives_on', object: '8 July', authoredBy: null },
    ])

    // idempotent: a second scan the same day creates nothing new
    const r2 = await runEventSurfacingScan(db, GROUP, now, TZ)
    expect(r2.created).toBe(0)
    expect(await eventReminders(db)).toHaveLength(3)
  })

  it('ONE heads-up per event, however many facts the message shredded into', async () => {
    // The reported bug: one arrival became five lines because each extracted triple got its own
    // nudge. Same subject + same day = one event.
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-01T09:00:00Z')
    const eventAt = new Date('2026-07-08T12:00:00Z')
    for (const [predicate, object] of [
      ['returns_home', 'on the 8th'],
      ['needs', 'a lift from the airport'],
      ['staying_in', 'his own room'],
    ]) {
      await reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'ryan noble', subjectKind: 'person', predicate, object },
        authoredBy: null,
        trustLevel: 'untrusted',
        eventAt,
      })
    }

    const res = await runEventSurfacingScan(db, GROUP, now, TZ)
    expect(res.scanned).toBe(3) // three facts…
    expect(res.created).toBe(3) // …but three STAGES of ONE event, not 3 facts × 3 stages
    // and every fact went into the one written line, so the nudge can say the whole thing
    expect(writeHeadsUp.mock.calls[0][0].map((f) => f.predicate).sort()).toEqual(['needs', 'returns_home', 'staying_in'])
  })

  it('a SKIP from the model schedules NOTHING (an unwanted heads-up is worse than none)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    writeHeadsUp.mockResolvedValue(null) // "that is not an event worth pinging the house about"
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'profile_note', object: 'has been here since May' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt: new Date('2026-07-08T12:00:00Z'),
    })
    const res = await runEventSurfacingScan(db, GROUP, new Date('2026-07-01T09:00:00Z'), TZ)
    expect(res).toEqual({ created: 0, scanned: 1, skipped: 3 })
    expect(await eventReminders(db)).toHaveLength(0)
  })

  it('NEVER surfaces a secret dated fact (a code/password rotation must not leak to the group)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-01T09:00:00Z')
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'the wifi password', predicate: 'changes_on', object: 'the 5th' },
      authoredBy: null,
      trustLevel: 'trusted',
      eventAt: new Date('2026-07-05T09:00:00Z'),
    })
    // is_secure fact is filtered out of upcomingDatedFacts → nothing scanned, nothing scheduled
    expect(await runEventSurfacingScan(db, GROUP, now, TZ)).toEqual({ created: 0, scanned: 0, skipped: 0 })
    expect(writeHeadsUp).not.toHaveBeenCalled() // a secret is never even shown to the writer
  })

  it('ignores a fact with no event_at and one whose event is in the past', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-10T09:00:00Z')
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'wifi', predicate: 'ssid', object: 'baumynet' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'the party', predicate: 'was_on', object: 'last week' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt: new Date('2026-07-03T09:00:00Z'),
    })
    expect(await runEventSurfacingScan(db, GROUP, now, TZ)).toEqual({ created: 0, scanned: 0, skipped: 0 })
  })

  it('never surfaces a reflect PROFILE, even if one somehow carries a date', async () => {
    // The line the house actually saw: "📔 Heads-up — Mad profile, today". A profile is prose
    // about a person, not an event — excluded at the query, so it can never reach the writer.
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'madeleine', subjectKind: 'person', predicate: 'profile', object: 'Owner of the house; moved in in March.' },
      authoredBy: null,
      trustLevel: 'system',
      eventAt: new Date('2026-07-08T12:00:00Z'),
    })
    expect(await runEventSurfacingScan(db, GROUP, new Date('2026-07-01T09:00:00Z'), TZ)).toEqual({ created: 0, scanned: 0, skipped: 0 })
  })
})
