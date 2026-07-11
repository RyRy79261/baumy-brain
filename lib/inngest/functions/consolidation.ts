import { DateTime } from 'luxon'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb, type Database } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { houseTz } from '@/lib/env'
import { recentUndatedFacts, setFactEventAt } from '@/lib/memory/facts'
import { parseWhen } from '@/lib/reminders/parse'
import { orphanedEventReminders, cancelReminder } from '@/lib/reminders/store'
import { runEventSurfacingScan } from '@/lib/inngest/functions/surfacing'

// Memory-decay bound: only re-examine knowledge learned in the last two weeks. Long enough to
// catch an event mentioned a while ago that is still upcoming (and to sweep in facts captured
// before event-surfacing shipped), short enough that the nightly pass stays cheap. A fact that
// gets its event_at set drops OUT of the candidate set (event_at IS NULL), so nothing re-processes.
const LOOKBACK_DAYS = 14

// End-of-day consolidation (docs/spec/event-surfacing.md §consolidation). The catch-up + integrity
// layer over event-surfacing. Two deterministic passes, decay-bounded:
//   A. CATCH-UP — for each recent CURRENT fact with no event_at, re-resolve its date phrase against
//      the fact's OWN recorded_at (unambiguous, unlike at scan time) and backfill event_at; then run
//      the surfacing scan so the freshly-dated events get their week/day/morning heads-ups. This is
//      what fixes "a date learned before the update never got a reminder".
//   B. INTEGRITY — cancel scheduled heads-ups whose anchoring fact is no longer current (superseded
//      or contradicted), closing the gap where the create-only scan would still fire a stale nudge.
// The LLM is NOT in this loop (deterministic parse + graph currency); a richer LLM contradiction
// judgment over the graph neighborhood is a documented follow-up.
export async function runConsolidationSweep(
  db: Database,
  groupId: string,
  now: Date,
  tz: string,
): Promise<{ backfilled: number; created: number; cancelled: number }> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)

  // A — catch up missed / pre-feature dates.
  const undated = await recentUndatedFacts(db, groupId, since)
  let backfilled = 0
  for (const f of undated) {
    // Resolve the fact's stored value against WHEN IT WAS RECORDED — "tomorrow night" said last
    // Tuesday means the Wednesday after, not tomorrow. chrono returns null for a non-date value,
    // so a plain attribute ("the extra room") is safely skipped.
    const parsed = parseWhen(f.objectValue, tz, DateTime.fromJSDate(f.recordedAt))
    if (!parsed || parsed.fireAt.getTime() <= now.getTime()) continue // unparseable or already past
    await setFactEventAt(db, f.id, parsed.fireAt)
    backfilled++
  }
  // Schedule heads-ups for everything now dated (idempotent — safe even with nothing backfilled).
  const { created } = await runEventSurfacingScan(db, groupId, now, tz)

  // B — integrity: a superseded/cancelled event must not still nudge.
  const orphans = await orphanedEventReminders(db, groupId)
  for (const o of orphans) await cancelReminder(db, o.id)

  return { backfilled, created, cancelled: orphans.length }
}

// Nightly, ahead of the 08:00 surfacing scan so a same-night catch-up is already dated by morning.
export const consolidationSweep = inngest.createFunction(
  { id: 'end-of-day-consolidate', retries: 1 },
  { cron: 'TZ=Europe/Berlin 30 22 * * *' },
  async ({ step }) => {
    return step.run('consolidate', async () => {
      const db = createHttpDb()
      const groupId = await getHouseChatId(db)
      if (!groupId) return { skipped: 'no-house' as const }
      // Proactive output (it creates/cancels heads-ups) → honor /pause, like the surfacing scan.
      const policy = await loadResponsePolicy(db)
      if (!policy.global_enabled) return { skipped: 'paused' as const }
      return runConsolidationSweep(db, groupId, new Date(), houseTz())
    })
  },
)
