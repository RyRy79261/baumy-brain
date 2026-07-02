import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'

// Natural-language time resolution (task-graph R1), DST-correct. Luxon interprets
// the parsed wall-clock components in the house tz using THAT date's offset — so
// a reminder in July resolves to CEST (+2) and one in January to CET (+1).
export interface ParsedWhen {
  fireAt: Date
  resolvedLocal: string
}

export function parseWhen(whenText: string, tz = 'Europe/Berlin', now: DateTime = DateTime.now()): ParsedWhen | null {
  const localNow = now.setZone(tz)
  // A Date whose SYSTEM-tz wall-clock equals the house's wall-clock now, so
  // chrono anchors relative expressions ("next friday") to the house's "today".
  const ref = new Date(localNow.year, localNow.month - 1, localNow.day, localNow.hour, localNow.minute, localNow.second)

  const results = chrono.parse(whenText, ref, { forwardDate: true })
  if (results.length === 0) return null
  const s = results[0].start

  const dt = DateTime.fromObject(
    {
      year: s.get('year') ?? localNow.year,
      month: s.get('month') ?? localNow.month,
      day: s.get('day') ?? localNow.day,
      hour: s.isCertain('hour') ? (s.get('hour') ?? 9) : 9, // default to 09:00 local
      minute: s.isCertain('minute') ? (s.get('minute') ?? 0) : 0,
      second: 0,
    },
    { zone: tz },
  )
  if (!dt.isValid) return null
  return { fireAt: dt.toJSDate(), resolvedLocal: dt.toFormat("cccc d LLLL yyyy, HH:mm '('ZZZZ')'") }
}
