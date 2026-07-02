import { DateTime, type WeekdayNumbers } from 'luxon'

// Next-run computation for a task cadence, tz-aware. Supported:
//   'daily'        → next 09:00 local
//   'weekly'       → +7 days
//   'mid-week'     → next Wednesday 09:00 local
//   'end-of-week'  → next Sunday 17:00 local
//   'every:Nd'     → +N days
// Returns null for an unknown cadence.
export function computeNextRun(cadence: string, from: DateTime = DateTime.now(), tz = 'Europe/Berlin'): Date | null {
  const now = from.setZone(tz)
  const atHour = (dt: DateTime, hour: number) => dt.set({ hour, minute: 0, second: 0, millisecond: 0 })

  if (cadence === 'daily') {
    let n = atHour(now, 9)
    if (n <= now) n = n.plus({ days: 1 })
    return n.toJSDate()
  }
  if (cadence === 'weekly') return now.plus({ days: 7 }).toJSDate()
  if (cadence === 'mid-week') return nextWeekdayAt(now, 3, 9) // Wed
  if (cadence === 'end-of-week') return nextWeekdayAt(now, 7, 17) // Sun

  const m = cadence.match(/^every:(\d+)d$/)
  if (m) return now.plus({ days: Number(m[1]) }).toJSDate()
  return null
}

function nextWeekdayAt(now: DateTime, weekday: WeekdayNumbers, hour: number): Date {
  let n = now.set({ weekday, hour, minute: 0, second: 0, millisecond: 0 })
  if (n <= now) n = n.plus({ weeks: 1 })
  return n.toJSDate()
}
