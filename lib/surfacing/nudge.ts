import { DateTime } from 'luxon'

// Proactive event-surfacing (docs/spec/event-surfacing.md): given a dated fact's absolute
// event_at, work out WHEN to give the house advance notice, and which facts belong to the SAME
// event. Pure + deterministic (no I/O), so the lead-time and grouping policy are unit-tested. The
// scan turns each returned stage into an event-anchored reminder, reusing the proven exactly-once
// delivery machinery; the LINE itself is written by the model (lib/ai/nudge.ts).

export type NudgeStage = 'week' | 'day' | 'morning'

// The three lead points the owner asked for: ~a week before, the day before, and the morning of.
// A stage is only scheduled if its fire time is still in the FUTURE and lands BEFORE the event —
// so an event captured late (e.g. 2 days out) gracefully gets just day+morning, never a nudge
// after the fact. Morning-of is 08:00 in the house tz (skipped when the event itself is earlier).
export function computeNudgeStages(eventAt: Date, now: Date, tz = 'Europe/Berlin'): { stage: NudgeStage; fireAt: Date }[] {
  const ev = DateTime.fromJSDate(eventAt).setZone(tz)
  const candidates: { stage: NudgeStage; fireAt: DateTime }[] = [
    { stage: 'week', fireAt: ev.minus({ days: 7 }) },
    { stage: 'day', fireAt: ev.minus({ days: 1 }) },
    { stage: 'morning', fireAt: ev.startOf('day').plus({ hours: 8 }) },
  ]
  const nowMs = now.getTime()
  const evMs = eventAt.getTime()
  return candidates
    .filter((c) => c.fireAt.toMillis() > nowMs && c.fireAt.toMillis() < evMs)
    .map((c) => ({ stage: c.stage, fireAt: c.fireAt.toJSDate() }))
}

// How the model is told to phrase the lead, and the date it renders — always from event_at, never
// the fact's stored words (often a relative phrase that is stale by the time the nudge fires).
export const leadFor = (stage: NudgeStage): 'next week' | 'tomorrow' | 'today' =>
  stage === 'week' ? 'next week' : stage === 'day' ? 'tomorrow' : 'today'

export const whenLabel = (eventAt: Date, tz = 'Europe/Berlin'): string =>
  DateTime.fromJSDate(eventAt).setZone(tz).toFormat('ccc d LLL')

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
