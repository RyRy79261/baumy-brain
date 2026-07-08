import { inngest } from '@/lib/inngest/client'
import { createHttpDb, type Database } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { houseTz } from '@/lib/env'
import { upcomingDatedFacts } from '@/lib/memory/facts'
import { createReminder, remindersForEventFact } from '@/lib/reminders/store'
import { computeNudgeStages, nudgeContent } from '@/lib/surfacing/nudge'

// Cover the ~7-day-ahead stage with a day of margin.
const HORIZON_DAYS = 8

// The scan CORE (exported for testing): for every current, non-secret dated fact in the horizon,
// ensure event-anchored reminders exist at each still-future lead stage, de-duped per fact so a
// re-run never double-schedules. Pure DB work — the cron wrapper resolves the house + pause gate.
export async function runEventSurfacingScan(
  db: Database,
  groupId: string,
  now: Date,
  tz: string,
): Promise<{ created: number; scanned: number }> {
  const to = new Date(now.getTime() + HORIZON_DAYS * 86_400_000)
  const dated = await upcomingDatedFacts(db, groupId, now, to)
  let created = 0
  for (const f of dated) {
    const stages = computeNudgeStages(f.eventAt, now, tz)
    if (stages.length === 0) continue
    // De-dupe by fire-minute against every reminder already tied to this fact (any status),
    // so a stage is never scheduled twice and a sent/cancelled one is not recreated.
    const existing = await remindersForEventFact(db, f.id)
    const seen = new Set(existing.map((r) => Math.floor(r.fireAt.getTime() / 60_000)))
    for (const s of stages) {
      if (seen.has(Math.floor(s.fireAt.getTime() / 60_000))) continue
      await createReminder(db, {
        groupId,
        deliverChatId: groupId, // fixed house group, code-resolved (never LLM)
        content: nudgeContent(f.subject, f.predicate, f.eventAt, s.stage, tz),
        fireAt: s.fireAt,
        anchorKind: 'event_offset',
        eventFactId: f.id,
        createdBy: null, // system-generated
      })
      seen.add(Math.floor(s.fireAt.getTime() / 60_000))
      created++
    }
  }
  return { created, scanned: dated.length }
}

// Proactive event-surfacing (docs/spec/event-surfacing.md): the missing "production path that
// creates reminders" the old subsystem never had. Once/day it reads DATED facts (event_at,
// populated at capture — the memory now actually stores when things happen) and, for each event
// coming up, ensures event-anchored reminders exist at the three lead points the owner asked for
// (~a week before, the day before, the morning of). It only CREATES the reminders; the proven
// arm → claim → send → mark-sent machinery delivers them exactly-once. De-duped per (event,
// stage), so a re-scan never double-schedules; secret facts are excluded; /pause silences it.
export const eventSurfacingScan = inngest.createFunction(
  { id: 'event-surfacing-scan' },
  { cron: 'TZ=Europe/Berlin 0 8 * * *' }, // daily 08:00 house tz — also when morning-of nudges fire
  async ({ step }) => {
    return step.run('scan', async () => {
      const db = createHttpDb()
      const houseChatId = await getHouseChatId(db)
      if (!houseChatId) return { created: 0, reason: 'no-house' as const }
      // Pause silences PROACTIVE output — the same gate that stops the ingest reminder step
      // creating reminders while paused. (Explicit reminders already scheduled still deliver.)
      const policy = await loadResponsePolicy(db)
      if (!policy.global_enabled) return { created: 0, reason: 'paused' as const }
      return runEventSurfacingScan(db, houseChatId, new Date(), houseTz())
    })
  },
)
