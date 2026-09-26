import { DateTime } from 'luxon'

// Proactive event-surfacing (docs/spec/event-surfacing.md): given a dated fact's absolute
// event_at, work out WHEN to give the house advance notice, and which facts belong to the SAME
// event. Pure + deterministic (no I/O), so the lead-time and grouping policy are unit-tested. The
// scan turns each returned stage into an event-anchored reminder, reusing the proven exactly-once
// delivery machinery; the LINE itself is written by the model (lib/ai/nudge.ts).

export type NudgeStage = 'week' | 'day' | 'morning'

// Heads-ups are delivered by the digest (08:00, and 20:00 when twice a day), so every stage is PINNED
// TO A DIGEST SLOT instead of an arbitrary offset — the old "event − 24h" stage of a Saturday-22:00
// party fell at Friday 22:00, missed the evening slot, and went out Saturday 08:00 saying "tomorrow"
// next to the "today" one (T11):
//   week    — 08:00, seven days before the event day;
//   day     — 20:00 the evening before the event day;
//   morning — 08:00 on the event day.
// A stage is only scheduled if its slot is still in the FUTURE and lands BEFORE the event (for an
// all-day event — local midnight start — before the END of that day, so it still gets its morning
// nudge). An event captured late (2 days out) gracefully gets just day + morning, never a nudge after
// the fact. The LEAD a line says is worked out again at delivery (leadAt) — the slot only decides when.
export const DIGEST_MORNING_HOUR = 8
export const DIGEST_EVENING_HOUR = 20

export const isAllDayStart = (eventAt: Date, tz: string): boolean => {
  const d = DateTime.fromJSDate(eventAt).setZone(tz)
  return d.hour === 0 && d.minute === 0
}

const stageSlots = (eventAt: Date, tz: string): { stage: NudgeStage; fireAt: DateTime }[] => {
  const evDay = DateTime.fromJSDate(eventAt).setZone(tz).startOf('day')
  return [
    { stage: 'week', fireAt: evDay.minus({ days: 7 }).set({ hour: DIGEST_MORNING_HOUR }) },
    { stage: 'day', fireAt: evDay.minus({ days: 1 }).set({ hour: DIGEST_EVENING_HOUR }) },
    { stage: 'morning', fireAt: evDay.set({ hour: DIGEST_MORNING_HOUR }) },
  ]
}

export function computeNudgeStages(eventAt: Date, now: Date, tz = 'Europe/Berlin'): { stage: NudgeStage; fireAt: Date }[] {
  const evDay = DateTime.fromJSDate(eventAt).setZone(tz).startOf('day')
  const candidates = stageSlots(eventAt, tz)
  const nowMs = now.getTime()
  const cutoff = isAllDayStart(eventAt, tz) ? evDay.endOf('day').toMillis() : eventAt.getTime()
  return candidates
    .filter((c) => c.fireAt.toMillis() > nowMs && c.fireAt.toMillis() < cutoff)
    .map((c) => ({ stage: c.stage, fireAt: c.fireAt.toJSDate() }))
}

// Which stage an EXISTING heads-up row is — the slot nearest its fire time. The scan de-dupes per
// (event, stage) with this, not per exact minute: a row scheduled under the old offsets (event − 7d at
// the event's own clock time, event − 24h) sits hours off the new digest slots, and a minute match
// would add a second stage row beside it — two "next week" lines on one day, in different digests.
// Nearest-slot maps an old −7d to 'week' and an old −24h to 'day' (always ≤ 20h from the evening
// slot, ≥ 4h further from the morning one); a slot-pinned row maps to itself.
export function nudgeStageOf(fireAt: Date, eventAt: Date, tz = 'Europe/Berlin'): NudgeStage {
  const t = fireAt.getTime()
  let best = stageSlots(eventAt, tz)[0]
  for (const c of stageSlots(eventAt, tz)) if (Math.abs(c.fireAt.toMillis() - t) < Math.abs(best.fireAt.toMillis() - t)) best = c
  return best.stage
}

// How far off the event is FROM THE MOMENT THE LINE IS POSTED, in calendar days of the house tz — never
// the stage it was scheduled for, never the fact's stored words (often a relative phrase that is stale
// by the time the nudge fires). Null when the event has already started (a timed one) or is over (an
// all-day one) — a heads-up after the fact is dropped, not posted.
export function leadAt(eventAt: Date, at: Date, tz = 'Europe/Berlin'): string | null {
  const ev = DateTime.fromJSDate(eventAt).setZone(tz)
  const now = DateTime.fromJSDate(at).setZone(tz)
  const allDay = isAllDayStart(eventAt, tz)
  if (allDay ? ev.endOf('day') <= now : ev <= now) return null
  const days = Math.round(ev.startOf('day').diff(now.startOf('day'), 'days').days)
  if (days <= 0) return !allDay && ev.hour >= 18 ? 'tonight' : 'today'
  if (days === 1) return 'tomorrow'
  if (days < 7) return `on ${ev.toFormat('cccc')} (in ${days} days)`
  if (days < 14) return 'next week'
  return `in ${days} days`
}

/** The lead a stage is SCHEDULED for (its slot relative to the event) — the scan's preview line. */
export const leadFor = (stage: NudgeStage): 'next week' | 'tomorrow' | 'today' =>
  stage === 'week' ? 'next week' : stage === 'day' ? 'tomorrow' : 'today'

/** The event's day (+ its time when it has one): "Sat 3 Oct" / "Sat 3 Oct, 22:00". */
export const whenLabel = (eventAt: Date, tz = 'Europe/Berlin'): string => {
  const d = DateTime.fromJSDate(eventAt).setZone(tz)
  return isAllDayStart(eventAt, tz) ? d.toFormat('ccc d LLL') : d.toFormat('ccc d LLL, HH:mm')
}

// ONE event, not one database row. A single message shreds into several fact triples ("Ryan
// returns home", "Ryan needs a lift"), each carrying the SAME resolved date — surfacing them
// row-by-row is what turned one arrival into five heads-up lines. Facts about the same SUBJECT on
// the same LOCAL DAY are one event: they get one nudge, written from all of them together.
export interface GroupableFact {
  id: string
  subjectEntityId: string
  eventAt: Date
}

export interface EventGroup<T extends GroupableFact> {
  key: string
  facts: T[]
  // The anchor is the earliest fact of the group (id as a stable tiebreak) — the row new reminders
  // are attached to. Dedupe still checks EVERY fact in the group, so a late-arriving sibling
  // cannot re-schedule a stage that already exists.
  anchor: T
  eventAt: Date
}

export function groupEvents<T extends GroupableFact>(facts: T[], tz = 'Europe/Berlin'): EventGroup<T>[] {
  const byKey = new Map<string, T[]>()
  for (const f of facts) {
    const day = DateTime.fromJSDate(f.eventAt).setZone(tz).toFormat('yyyy-LL-dd')
    const key = `${f.subjectEntityId}|${day}`
    byKey.set(key, [...(byKey.get(key) ?? []), f])
  }
  return [...byKey.entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime() || a.id.localeCompare(b.id))
    return { key, facts: sorted, anchor: sorted[0], eventAt: sorted[0].eventAt }
  })
}
