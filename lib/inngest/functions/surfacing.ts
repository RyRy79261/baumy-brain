import { DateTime } from 'luxon'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb, type Database } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { houseTz } from '@/lib/env'
import { upcomingDatedFacts, eventGroupFacts, type DatedFact } from '@/lib/memory/facts'
import { memberDisplayNames } from '@/lib/identity/roster'
import { createReminder, remindersForEventFacts } from '@/lib/reminders/store'
import { computeNudgeStages, groupEvents, leadAt, whenLabel } from '@/lib/surfacing/nudge'
import { writeHeadsUp, type HeadsUpFact } from '@/lib/ai/nudge'
import { now as clockNow } from '@/lib/core/clock'

// Cover the ~7-day-ahead stage with a day of margin.
const HORIZON_DAYS = 8

// The scan CORE (exported for testing): for every current, non-secret dated fact in the horizon,
// ensure event-anchored reminders exist at each still-future lead stage. Two things keep this from
// spamming the group (the failure the house actually saw — five stub lines from one message):
//   • GROUPING — facts about the same subject on the same day are ONE event, one heads-up, not one
//     per extracted triple. De-duped against every reminder already tied to ANY fact in the group.
//   • The LINE IS WRITTEN, not templated — the model reads the group's facts and writes a sentence,
//     or says SKIP. A skip (or any model hiccup) schedules nothing; the next scan retries.
export async function runEventSurfacingScan(
  db: Database,
  groupId: string,
  now: Date,
  tz: string,
): Promise<{ created: number; scanned: number; skipped: number }> {
  const to = new Date(now.getTime() + HORIZON_DAYS * 86_400_000)
  // From the start of the house day: an all-day event today starts at local midnight, before the scan.
  const dayStart = DateTime.fromJSDate(now).setZone(tz).startOf('day').toJSDate()
  const dated = await upcomingDatedFacts(db, groupId, dayStart, to, now)
  const names = await memberDisplayNames(db)
  let created = 0
  let skipped = 0
  for (const ev of groupEvents(dated, tz)) {
    const stages = computeNudgeStages(ev.eventAt, now, tz)
    if (stages.length === 0) continue
    // De-dupe by fire-minute across EVERY fact in the group (any status), so a stage is never
    // scheduled twice, a sibling fact cannot re-open one, and a sent/cancelled one is not recreated.
    const existing = await remindersForEventFacts(
      db,
      ev.facts.map((f) => f.id),
    )
    const seen = new Set(existing.map((r) => Math.floor(r.fireAt.getTime() / 60_000)))
    const knowledge = toKnowledge(ev.facts, names)
    for (const s of stages) {
      if (seen.has(Math.floor(s.fireAt.getTime() / 60_000))) continue
      // The PREVIEW line, phrased for the moment the stage is due (the digest slot). It is the SKIP
      // gate and what /reminders shows; the posted line is written again at delivery (headsUpAtDelivery).
      const lead = leadAt(ev.eventAt, s.fireAt, tz)
      const line = lead ? await writeHeadsUp(knowledge, lead, whenLabel(ev.eventAt, tz)) : null
      if (!line) {
        // Not an event / not worth pinging the house (or the model errored). Schedule NOTHING —
        // an unwanted heads-up is worse than a missed one. Nothing is written, so a later scan
        // re-asks; a genuinely skippable event just stays quiet.
        skipped++
        continue
      }
      await createReminder(db, {
        groupId,
        deliverChatId: groupId, // fixed house group, code-resolved (never LLM)
        content: line,
        fireAt: s.fireAt,
        anchorKind: 'event_offset',
        eventFactId: ev.anchor.id,
        createdBy: null, // system-generated
      })
      seen.add(Math.floor(s.fireAt.getTime() / 60_000))
      created++
    }
  }
  return { created, scanned: dated.length, skipped }
}

const toKnowledge = (facts: DatedFact[], names: Map<string, string>): HeadsUpFact[] =>
  facts.map((f) => ({
    subject: f.subject,
    predicate: f.predicate,
    object: f.objectValue,
    authoredBy: f.authoredBy ? (names.get(f.authoredBy) ?? null) : null,
  }))

// The heads-up LINE is written at DELIVERY time (T11), from the event's facts as they are NOW and the
// real lead from the delivery instant: a nudge scheduled as "tomorrow" that only goes out on the event
// day (a missed evening slot, a once-a-day digest) says "today"; one whose event moved, ended or was
// forgotten is not posted at all. `key` identifies the EVENT (subject + local day) so one digest never
// posts two stages of the same event. Null line = drop this stage (cancel), with the reason logged.
// A transient model error rethrows — the digest releases its claims and retries (I2).
export async function headsUpAtDelivery(
  db: Database,
  anchorFactId: string | null,
  at: Date,
  tz: string,
): Promise<{ key: string; line: string } | { key: string | null; line: null; reason: 'no-event' | 'over' | 'skip' }> {
  if (!anchorFactId) return { key: null, line: null, reason: 'no-event' }
  const facts = await eventGroupFacts(db, anchorFactId, tz, at)
  if (facts.length === 0) return { key: null, line: null, reason: 'no-event' }
  const [first] = groupEvents(facts, tz)
  const lead = leadAt(first.eventAt, at, tz)
  if (!lead) return { key: first.key, line: null, reason: 'over' }
  const line = await writeHeadsUp(toKnowledge(first.facts, await memberDisplayNames(db)), lead, whenLabel(first.eventAt, tz))
  return line ? { key: first.key, line } : { key: first.key, line: null, reason: 'skip' }
}

// Proactive event-surfacing (docs/spec/event-surfacing.md): the missing "production path that
// creates reminders" the old subsystem never had. Once/day it reads DATED facts (event_at,
// populated at capture — the memory now actually stores when things happen) and, for each event
// coming up, ensures event-anchored reminders exist at the three lead points the owner asked for
// (a week before, the evening before, the morning of — each a digest slot). It only CREATES the reminders; the proven
// arm → claim → send → mark-sent machinery delivers them exactly-once. De-duped per (event,
// stage), so a re-scan never double-schedules; secret facts are excluded; /pause silences it.
export const eventSurfacingScan = inngest.createFunction(
  { id: 'event-surfacing-scan' },
  // Daily 07:45 house tz — just BEFORE the 08:00 digest, so an event learned overnight still gets its
  // morning-of nudge at 08:00 (a scan AT 08:00 raced the digest and dropped it — T11).
  { cron: 'TZ=Europe/Berlin 45 7 * * *' },
  async ({ step }) => {
    return step.run('scan', async () => {
      const db = createHttpDb()
      const houseChatId = await getHouseChatId(db)
      if (!houseChatId) return { created: 0, reason: 'no-house' as const }
      // Pause silences PROACTIVE output — the same gate that stops the ingest reminder step
      // creating reminders while paused. (Explicit reminders already scheduled still deliver.)
      const policy = await loadResponsePolicy(db)
      if (!policy.global_enabled) return { created: 0, reason: 'paused' as const }
      return runEventSurfacingScan(db, houseChatId, clockNow(), houseTz())
    })
  },
)
