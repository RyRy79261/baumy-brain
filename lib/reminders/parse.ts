import { DateTime } from 'luxon'
import { now as clockNow } from '@/lib/core/clock'
import { resolveWhen, reminderTimeFromPhrase, eventWindowFromResolved, type EventWindow } from '@/lib/core/when'

// Natural-language time resolution for the two FALLBACK paths (task-graph R1, DST-correct). The rules
// live in lib/core/when.ts — one resolver for reminders, facts and the backfill (spec §6, T12). The
// primary path is the extractor model resolving against the calendar table; these read a verbatim
// phrase only when the model gave no usable value (live) or re-read a stored value (backfill).
export interface ParsedWhen {
  fireAt: Date
  resolvedLocal: string
}

// Reminding hours are 06:00–02:00 house tz — nobody wants a ping at 3am. A fire time that lands in
// the 02:00–06:00 dead zone is nudged forward to 06:00 the same day. Applied to explicit "remind me
// at X" reminders at creation (event heads-ups are delivered by the daytime digest, so they're
// waking-hours by construction). Baumy is a house secretary, not an alarm clock.
export function clampToWakingHours(fireAt: Date, tz = 'Europe/Berlin'): Date {
  const dt = DateTime.fromJSDate(fireAt).setZone(tz)
  if (dt.hour >= 2 && dt.hour < 6) {
    return dt.set({ hour: 6, minute: 0, second: 0, millisecond: 0 }).toJSDate()
  }
  return fireAt
}

const describe = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat("cccc d LLLL yyyy, HH:mm '('ZZZZ')'")
const clockDt = () => DateTime.fromJSDate(clockNow())

// The LIVE fallback: an explicit "remind me at X" whose phrase the extractor isolated, so the phrase IS
// the whole input. A bare date fires at 09:00.
export function parseWhen(whenText: string, tz = 'Europe/Berlin', now: DateTime = clockDt()): ParsedWhen | null {
  const t = reminderTimeFromPhrase(whenText, tz, now.toJSDate())
  return t ? { fireAt: t.fireAt, resolvedLocal: describe(t.fireAt, tz) } : null
}

// The BACKFILL path (docs/spec/event-surfacing.md §consolidation): re-read a fact's STORED value
// and decide whether it names a concrete event date. Precision-first — this feeds the proactive
// heads-ups, and a false positive means the house gets pinged about a sentence that was never an
// event. The SAME resolver as capture, read against when the fact was RECORDED (so "monday morning"
// recorded on a Thursday is the Monday after — T12; a past marker is still read literally), plus
// three guards the live path does not need:
//   • coverage — the date phrase must be most of the value, not one word plucked from prose;
//   • a KNOWN day or weekday — a bare month ("March") or year is not an event date;
//   • length — long values are prose (a reflect profile, a description) and are rejected outright.
const MAX_EVENT_VALUE_LEN = 120
const MIN_COVERAGE = 0.6

export function parseEventWindow(value: string, tz = 'Europe/Berlin', recordedAt: DateTime = clockDt()): EventWindow | null {
  if (value.trim().length > MAX_EVENT_VALUE_LEN) return null
  const r = resolveWhen(value, { tz, now: recordedAt })
  if (!r || !r.knownDay || r.coverage < MIN_COVERAGE) return null
  return eventWindowFromResolved(r, tz)
}

export function parseEventDate(value: string, tz = 'Europe/Berlin', recordedAt: DateTime = clockDt()): ParsedWhen | null {
  const w = parseEventWindow(value, tz, recordedAt)
  return w ? { fireAt: w.eventAt, resolvedLocal: describe(w.eventAt, tz) } : null
}
