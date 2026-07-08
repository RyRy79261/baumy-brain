import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import { runEventSurfacingScan } from '@/lib/inngest/functions/surfacing'

const GROUP = '-100surf'
const TZ = 'Europe/Berlin'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

const eventReminders = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  db.select().from(reminders).where(eq(reminders.groupId, GROUP))

describe('event-surfacing scan — dated facts become event-anchored reminders', () => {
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
    expect(r1).toEqual({ created: 3, scanned: 1 })
    const rows = await eventReminders(db)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.anchorKind === 'event_offset')).toBe(true) // heads-up, delivered as 🗓️
    expect(rows.every((r) => r.eventFactId != null)).toBe(true) // anchored to the fact for dedup
    expect(rows.some((r) => r.content.includes('next week'))).toBe(true)
    expect(rows.some((r) => r.content.includes('tomorrow'))).toBe(true)

    // idempotent: a second scan the same day creates nothing new
    const r2 = await runEventSurfacingScan(db, GROUP, now, TZ)
    expect(r2.created).toBe(0)
    expect(await eventReminders(db)).toHaveLength(3)
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
    expect(await runEventSurfacingScan(db, GROUP, now, TZ)).toEqual({ created: 0, scanned: 0 })
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
    expect(await runEventSurfacingScan(db, GROUP, now, TZ)).toEqual({ created: 0, scanned: 0 })
  })
})
