import { DateTime } from 'luxon'

// Proactive event-surfacing (docs/spec/event-surfacing.md): given a dated fact's absolute
// event_at, work out WHEN to give the house advance notice and WHAT the heads-up says. Pure +
// deterministic (no I/O), so the lead-time policy is unit-tested. The scan turns each returned
// stage into an event-anchored reminder, reusing the proven exactly-once delivery machinery.

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

// The heads-up text (delivery adds the 🗓️ prefix). Built from the fact's subject + predicate +
// a FRESH date rendered from event_at — never the fact's stored object, because that is often the
// original relative phrase ("tomorrow night") which is stale by the time the nudge fires.
export function nudgeContent(subject: string, predicate: string, eventAt: Date, stage: NudgeStage, tz = 'Europe/Berlin'): string {
  const lead = stage === 'week' ? 'next week' : stage === 'day' ? 'tomorrow' : 'today'
  const when = DateTime.fromJSDate(eventAt).setZone(tz).toFormat('ccc d LLL')
  const subj = subject.charAt(0).toUpperCase() + subject.slice(1)
  const pred = predicate.replace(/_/g, ' ').trim()
  const basis = pred ? `${subj} ${pred}` : subj
  return `Heads-up — ${basis}, ${lead} (${when})`
}
