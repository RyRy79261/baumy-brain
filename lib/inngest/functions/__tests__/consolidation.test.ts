import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { facts, reminders } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact, recentUndatedFacts } from '@/lib/memory/facts'
import { runEventSurfacingScan } from '@/lib/inngest/functions/surfacing'
import { runConsolidationSweep } from '@/lib/inngest/functions/consolidation'

const GROUP = '-100consol'
const TZ = 'Europe/Berlin'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')

describe('end-of-day consolidation — catch-up + integrity', () => {
  it('catches up a recent dated fact that never got an event_at, and schedules its heads-ups', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date()
    // A fact whose date lives in object_value, captured just now (recorded_at ≈ now), event_at NULL —
    // the shape of a pre-feature / extractor-missed dated fact.
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'arrives_on', object: 'in 5 days' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    const [before] = await db.select({ e: facts.eventAt }).from(facts).where(eq(facts.groupId, GROUP))
    expect(before.e).toBeNull()

    const res = await runConsolidationSweep(db, GROUP, now, TZ)
    expect(res.backfilled).toBe(1)
    expect(res.created).toBeGreaterThanOrEqual(1)
    // event_at is now set (resolved against recorded_at), and event-anchored heads-ups exist
    const [after] = await db.select({ e: facts.eventAt }).from(facts).where(eq(facts.groupId, GROUP))
    expect(after.e).not.toBeNull()
    const rem = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(rem.length).toBeGreaterThanOrEqual(1)
    expect(rem.every((r) => r.anchorKind === 'event_offset')).toBe(true)

    // idempotent: the fact now has event_at → drops out of the candidate set; nothing new
    const res2 = await runConsolidationSweep(db, GROUP, now, TZ)
    expect(res2.backfilled).toBe(0)
    expect(res2.created).toBe(0)
  })

  it('never invents a date from a non-date value ("the extra room" stays undated)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'iman', predicate: 'staying_in', object: 'the extra room' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    expect((await runConsolidationSweep(db, GROUP, new Date(), TZ)).backfilled).toBe(0)
    const [f] = await db.select({ e: facts.eventAt }).from(facts).where(eq(facts.groupId, GROUP))
    expect(f.e).toBeNull()
  })

  it('INTEGRITY: cancels the heads-ups of an event that later got superseded/cancelled', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date()
    const eventAt = new Date(now.getTime() + 5 * 86_400_000)
    // an upcoming dated event → the scan schedules its heads-ups
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'nadia', subjectKind: 'person', predicate: 'arrives_on', object: 'friday' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt,
    })
    expect((await runEventSurfacingScan(db, GROUP, now, TZ)).created).toBeGreaterThanOrEqual(1)
    expect((await db.select().from(reminders).where(eq(reminders.groupId, GROUP))).length).toBeGreaterThanOrEqual(1)

    // …then the plan changes: same subject+predicate, new value → supersedes the dated fact
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'nadia', subjectKind: 'person', predicate: 'arrives_on', object: 'cancelled' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })

    const res = await runConsolidationSweep(db, GROUP, now, TZ)
    expect(res.cancelled).toBeGreaterThanOrEqual(1)
    // every heads-up for the now-stale event is cancelled — it will not fire
    const rows = await db.select().from(reminders).where(eq(reminders.groupId, GROUP))
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
  })

  it('recency-bounds the scan by recorded_at (an old undated fact is out of scope)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'ghost', predicate: 'visits_on', object: 'tomorrow' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    // backdate it 20 days — beyond the 14-day decay window
    await db.update(facts).set({ recordedAt: new Date(Date.now() - 20 * 86_400_000) }).where(eq(facts.groupId, GROUP))
    const since = new Date(Date.now() - 14 * 86_400_000)
    expect(await recentUndatedFacts(db, GROUP, since)).toHaveLength(0)
  })
})
