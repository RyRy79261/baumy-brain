import { DateTime } from 'luxon'

// RRULE-lite for recurring reminders (docs/spec/chat-understanding-v2.md §6, D3 / A6):
//   FREQ=DAILY|WEEKLY|MONTHLY [;INTERVAL=n] [;BYDAY=MO,TH] [;BYMONTHDAY=9]
// The extractor PROPOSES a rule; this module DISPOSES: an unknown key/value, a zero interval, a BYDAY
// on a non-weekly rule — anything outside the lite grammar — is rejected (the reminder is then a
// one-off, and the confirm line shows it). Normalised at creation so the rule alone pins the series'
// day(s): a WEEKLY rule without BYDAY gets the first occurrence's weekday, a MONTHLY rule its day of
// month — so a month-end clamp can never drift the series.
//
// Pure (explicit instants + tz); the time of day is the previous occurrence's local wall-clock time,
// so a weekly 20:00 stays 20:00 across a DST change.

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export interface Rule {
  freq: Freq
  interval: number
  byDay: number[] // luxon weekdays: 1 = Monday … 7 = Sunday
  byMonthDay: number | null
}

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MAX_INTERVAL = 52

/** Parse a lite rule; null when it is anything outside the grammar. */
export function parseRule(raw: string | null | undefined): Rule | null {
  const s = raw?.trim().toUpperCase().replace(/^RRULE:/, '')
  if (!s) return null
  const rule: Rule = { freq: 'DAILY', interval: 1, byDay: [], byMonthDay: null }
  let freq: string | null = null
  for (const part of s.split(';').filter(Boolean)) {
    const [k, v] = part.split('=')
    if (!v) return null
    if (k === 'FREQ') freq = v
    else if (k === 'INTERVAL') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) return null
      rule.interval = n
    } else if (k === 'BYDAY') {
      const days = v.split(',').map((d) => DAY_CODES.indexOf(d.trim()) + 1)
      if (days.some((d) => d < 1)) return null
      rule.byDay = [...new Set(days)].sort((a, b) => a - b)
    } else if (k === 'BYMONTHDAY') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 31) return null
      rule.byMonthDay = n
    } else return null
  }
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null
  rule.freq = freq
  if (rule.byDay.length && rule.freq !== 'WEEKLY') return null
  if (rule.byMonthDay && rule.freq !== 'MONTHLY') return null
  return rule
}

export function formatRule(r: Rule): string {
  const parts = [`FREQ=${r.freq}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.byDay.length) parts.push(`BYDAY=${r.byDay.map((d) => DAY_CODES[d - 1]).join(',')}`)
  if (r.byMonthDay) parts.push(`BYMONTHDAY=${r.byMonthDay}`)
  return parts.join(';')
}

/** Validate + pin the rule to its first occurrence (see header). Null = not a valid lite rule. */
export function normaliseRecurrence(raw: string | null | undefined, firstFireAt: Date, tz: string): string | null {
  const r = parseRule(raw)
  if (!r) return null
  const first = DateTime.fromJSDate(firstFireAt).setZone(tz)
  if (r.freq === 'WEEKLY' && r.byDay.length === 0) r.byDay = [first.weekday]
  if (r.freq === 'MONTHLY' && !r.byMonthDay) r.byMonthDay = first.day
  return formatRule(r)
}

/**
 * The first occurrence of `rule` strictly after `after`, keeping `prev`'s local time of day. `prev` is
 * the occurrence just delivered (or retired); the series steps from it, so an INTERVAL counts from the
 * series, not from whenever delivery happened to run. Null for an invalid rule.
 */
export function nextOccurrence(raw: string, prev: Date, after: Date, tz: string): Date | null {
  const r = parseRule(raw)
  if (!r) return null
  const p = DateTime.fromJSDate(prev).setZone(tz)
  const time = { hour: p.hour, minute: p.minute, second: 0, millisecond: 0 }
  const floor = Math.max(after.getTime(), prev.getTime())
  const ok = (d: DateTime) => d.toMillis() > floor

  if (r.freq === 'DAILY') {
    let d = p.plus({ days: r.interval })
    for (let i = 0; i < 5000 && !ok(d); i++) d = d.plus({ days: r.interval })
    return ok(d) ? d.set(time).toJSDate() : null
  }
  if (r.freq === 'WEEKLY') {
    const days = r.byDay.length ? r.byDay : [p.weekday]
    const weekStart = p.startOf('week') // luxon weeks start on Monday
    for (let w = 0; w < 800; w += r.interval) {
      for (const wd of days) {
        const d = weekStart.plus({ weeks: w, days: wd - 1 }).set(time)
        if (d > p && ok(d)) return d.toJSDate()
      }
    }
    return null
  }
  // MONTHLY: the pinned day, clamped to the month's last day (the 31st in a 30-day month → the 30th).
  const dom = r.byMonthDay ?? p.day
  for (let m = r.interval; m < 600; m += r.interval) {
    const month = p.startOf('month').plus({ months: m })
    const d = month.set({ day: Math.min(dom, month.daysInMonth ?? 28) }).set(time)
    if (ok(d)) return d.toJSDate()
  }
  return null
}

/** "every Friday", "every 2 weeks on Monday and Thursday", "every month on the 9th", "every day". */
export function describeRecurrence(raw: string | null | undefined): string | null {
  const r = parseRule(raw)
  if (!r) return null
  const n = r.interval
  if (r.freq === 'DAILY') return n === 1 ? 'every day' : `every ${n} days`
  if (r.freq === 'WEEKLY') {
    const names = r.byDay.map((d) => DAY_NAMES[d - 1])
    const on = names.length ? names.join(names.length === 2 ? ' and ' : ', ') : ''
    if (n === 1) return on ? `every ${on}` : 'every week'
    return `every ${n} weeks${on ? ` on ${on}` : ''}`
  }
  const dom = r.byMonthDay
  const ord = dom ? `${dom}${dom % 10 === 1 && dom !== 11 ? 'st' : dom % 10 === 2 && dom !== 12 ? 'nd' : dom % 10 === 3 && dom !== 13 ? 'rd' : 'th'}` : null
  return `${n === 1 ? 'every month' : `every ${n} months`}${ord ? ` on the ${ord}` : ''}`
}

// The FALLBACK reading of a recurrence out of the verbatim time phrase, for when the extractor put
// "every friday at 8pm" in whenText but left recurrence empty. Deliberately tiny: "every day/daily",
// "every <weekday>[s]", "every week/weekly", "every month/monthly". Anything else stays a one-off.
export function recurrenceFromPhrase(phrase: string | null | undefined): string | null {
  const t = phrase?.trim().toLowerCase() ?? ''
  if (/\b(every\s*day|daily|each day)\b/.test(t)) return 'FREQ=DAILY'
  const wd = t.match(/\b(?:every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/)
  if (wd) return `FREQ=WEEKLY;BYDAY=${DAY_CODES[DAY_NAMES.findIndex((d) => d.toLowerCase() === wd[1])]}`
  if (/\b(every|each)\s+week\b|\bweekly\b/.test(t)) return 'FREQ=WEEKLY'
  if (/\b(every|each)\s+month\b|\bmonthly\b/.test(t)) return 'FREQ=MONTHLY'
  return null
}
