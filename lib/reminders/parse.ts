import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'

// Natural-language time resolution (task-graph R1), DST-correct. Luxon interprets
// the parsed wall-clock components in the house tz using THAT date's offset — so
// a reminder in July resolves to CEST (+2) and one in January to CET (+1).
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

// A time-of-day word chrono resolves to a real hour (evening → 20:00) even though it never marks
// that hour "certain". Without this, "tomorrow evening" silently became a 09:00 ping — the default
// below would overwrite chrono's 20. An explicit clock time ("at 8pm") IS certain and always wins.
const DAYPART = /\b(morning|noon|midday|afternoon|evening|tonight|night|midnight)\b/i

interface ParseOpts {
  tz: string
  now: DateTime
  // Push a bare date/weekday to its NEXT occurrence. TRUE for a live "remind me friday" (they mean
  // the coming Friday). FALSE when re-reading an old stored value — see parseEventDate.
  forwardDate: boolean
  // Minimum share of the input chrono's match must cover for the value to count as a time phrase.
  // 0 disables the check.
  minCoverage: number
}

// Internal: the parse plus whether a DAY (or weekday) was actually stated — the backfill gate.
interface CoreParse extends ParsedWhen {
  knownDay: boolean
}

function parseCore(text: string, opts: ParseOpts): CoreParse | null {
  const localNow = opts.now.setZone(opts.tz)
  // A Date whose SYSTEM-tz wall-clock equals the house's wall-clock now, so
  // chrono anchors relative expressions ("next friday") to the house's "today".
  const ref = new Date(localNow.year, localNow.month - 1, localNow.day, localNow.hour, localNow.minute, localNow.second)

  const results = chrono.parse(text, ref, { forwardDate: opts.forwardDate })
  if (results.length === 0) return null
  const hit = results[0]
  const s = hit.start

  // COVERAGE GATE: chrono happily plucks "March" out of a 200-char biography and hands back a
  // confident date. Require the match to actually BE most of the value, so a prose blob or a
  // past-tense aside ("was supposed to leave on Sunday") is not mistaken for a date phrase.
  const trimmed = text.trim()
  if (opts.minCoverage > 0 && hit.text.length / Math.max(trimmed.length, 1) < opts.minCoverage) return null

  const known = new Set(Object.keys((s as unknown as { knownValues: Record<string, number> }).knownValues))
  const hasDaypart = DAYPART.test(hit.text)
  // Honour a real time of day; otherwise 09:00 local (a morning-ish default, not 3am).
  const hour = s.isCertain('hour') || hasDaypart ? (s.get('hour') ?? 9) : 9
  const minute = s.isCertain('minute') || hasDaypart ? (s.get('minute') ?? 0) : 0

  const dt = DateTime.fromObject(
    {
      year: s.get('year') ?? localNow.year,
      month: s.get('month') ?? localNow.month,
      day: s.get('day') ?? localNow.day,
      hour,
      minute,
      second: 0,
    },
    { zone: opts.tz },
  )
  if (!dt.isValid) return null
  return {
    fireAt: dt.toJSDate(),
    resolvedLocal: dt.toFormat("cccc d LLLL yyyy, HH:mm '('ZZZZ')'"),
    knownDay: known.has('day') || known.has('weekday'),
  }
}

// The LIVE path: an explicit "remind me at X" whose whenText the extractor already isolated, so the
// phrase IS the whole input. forwardDate — "friday" said today means the coming Friday.
export function parseWhen(whenText: string, tz = 'Europe/Berlin', now: DateTime = DateTime.now()): ParsedWhen | null {
  const p = parseCore(whenText, { tz, now, forwardDate: true, minCoverage: 0 })
  return p ? { fireAt: p.fireAt, resolvedLocal: p.resolvedLocal } : null
}

// The BACKFILL path (docs/spec/event-surfacing.md §consolidation): re-read a fact's STORED value
// and decide whether it names a concrete event date. Precision-first — this feeds the proactive
// heads-ups, and a false positive means the house gets pinged about a sentence that was never an
// event. Three guards the live path does not need:
//   • no forwardDate — an old value is read literally against when it was RECORDED, so a past
//     mention stays past ("on Sunday" said on a Monday is that Sunday, not next one) instead of
//     being rolled forward into a fake future event;
//   • coverage — the date phrase must be most of the value, not one word plucked from prose;
//   • a KNOWN day or weekday — a bare month ("March") or year is not an event date.
// Long values are prose (a reflect profile, a description) and are rejected outright.
const MAX_EVENT_VALUE_LEN = 120

export function parseEventDate(value: string, tz = 'Europe/Berlin', recordedAt: DateTime = DateTime.now()): ParsedWhen | null {
  if (value.trim().length > MAX_EVENT_VALUE_LEN) return null
  const p = parseCore(value, { tz, now: recordedAt, forwardDate: false, minCoverage: 0.6 })
  if (!p || !p.knownDay) return null
  return { fireAt: p.fireAt, resolvedLocal: p.resolvedLocal }
}
