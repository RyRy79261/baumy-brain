import * as chrono from 'chrono-node'
import { DateTime } from 'luxon'

// THE time resolver (docs/spec/chat-understanding-v2.md §6). Two jobs, one set of rules:
//
//   • VALIDATE what the extractor model resolved itself — a fact's `when {start, end?, allDay}` or a
//     reminder's `fireAt`, local ISO read against the 21-day calendar table it was shown
//     (lib/core/calendar.ts). Code checks it is parseable, not absurdly far off, end ≥ start.
//   • FALL BACK to chrono on the verbatim time phrase when the model gave no usable value — and as the
//     nightly backfill's reader (T12). chrono alone gets house talk wrong in predictable ways, so the
//     phrase is normalised first and a fixed set of defaults is applied (the same ones TIME_RULES tells
//     the model, so live and fallback agree):
//       – filler ("around", "~", "-ish") is dropped, and split date/time hits are MERGED, so "friday
//         around 10pm" is Friday 22:00, not Friday 09:00 (T4);
//       – a bare clock hour is the NEXT time it comes round, never the 02:00–06:00 dead zone ("at 5" at
//         14:00 → 17:00 today); with a day named, 1–7 means pm (T9);
//       – dayparts keep their meaning: morning 09:00, noon 12:00, afternoon 15:00, evening/tonight
//         20:00, night 22:00 (T10 — chrono's "morning" is 06:00);
//       – a weekday is its next occurrence, and the same weekday said ON that day is today while the
//         time is still ahead; "this weekend" on a Saturday/Sunday is THIS weekend (T7);
//       – a past marker ("last", "yesterday", "ago") is read literally, never rolled forward (T7);
//       – "the 9th" is the next 9th of a month (T8); "end of the month" its last day; "a week before
//         friday" is Friday minus a week; a duration ("for a week") is not a time at all (T10);
//       – late at night (00:00–04:00) "tomorrow" means the day that is dawning — the calendar date of
//         NOW — because that is what people mean at 00:30 (T10);
//       – slashed dates are day/month outside the Americas ("9/10" = 9 October, T4).
//
// Pure: explicit `now` + tz in, instants out (DST-correct via luxon — the wall-clock parts are placed
// in the house zone using THAT date's offset). Callers read `now` from lib/core/clock.ts (T13).

/** How far from now any resolved date may be — past or future. Beyond that it is a misread. */
export const MAX_YEARS_OUT = 2
/** A timed event with no stated end is treated as lasting this long (spec §6). */
export const DEFAULT_EVENT_HOURS = 6
/** When nothing more specific is said, a reminder fires at this local hour. */
export const DEFAULT_REMINDER_HOUR = 9

export const DAYPART_HOURS: Record<string, number> = {
  morning: 9,
  noon: 12,
  midday: 12,
  lunchtime: 12,
  afternoon: 15,
  evening: 20,
  tonight: 20,
  night: 22,
  midnight: 0,
}
const DAYPART = new RegExp(`\\b(${Object.keys(DAYPART_HOURS).join('|')})\\b`, 'i')

export interface ResolvedWhen {
  /** Start instant. For an all-day value, local midnight of that day. */
  start: Date
  /** End instant of a stated range ("this weekend" → end of Sunday), else null. */
  end: Date | null
  /** No time of day at all — a date (or range of dates). */
  allDay: boolean
  /** A clock time was stated ("10pm", "at 5") — as opposed to a daypart or nothing. */
  exactTime: boolean
  /** A day, date or weekday was stated (not just a time). The backfill needs one. */
  knownDay: boolean
  /** Share of the phrase the parse actually covered (0–1). */
  coverage: number
}

export interface ResolveOpts {
  tz: string
  now: DateTime
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const PAST_MARKER = /\b(last|yesterday|ago|previous|earlier)\b/i
const DURATION = /^for\s+(a|an|one|two|three|four|five|six|seven|a few|several|\d+)\s+(minute|hour|day|night|week|month|year)s?\b/i
const OFFSET = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(minute|hour|day|week)s?\s+(before|after)\s+(.+)$/i
const ORDINAL = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i
const MONTH_NAME = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i

const localeFor = (tz: string) => (tz.startsWith('America/') ? chrono.en : chrono.en.GB)

/** Filler out, recurrence word out, whitespace collapsed. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/~/g, ' ')
    .replace(/\b(at\s+)?(around|about|approx\.?|approximately|roughly|circa)\b/g, ' at ')
    .replace(/(?<=\d)\s?-?ish\b/g, '')
    .replace(/^\s*every\s+/, '')
    .replace(/\s+at\s+at\s+/g, ' at ')
    .replace(/\s+/g, ' ')
    .replace(/^at\s+(?=\D)/, '')
    .trim()
}

function weekendRange(text: string, now: DateTime): { start: DateTime; end: DateTime } | null {
  const m = text.match(/^(?:for\s+|over\s+)?(this|the|next|this coming)?\s*weekend$/)
  if (!m) return null
  const today = now.startOf('day')
  // luxon weekday: 1 = Monday … 6 = Saturday, 7 = Sunday.
  let sat = today.weekday === 7 ? today.minus({ days: 1 }) : today.plus({ days: (6 - today.weekday + 7) % 7 })
  if (m[1] === 'next' && today.weekday >= 6) sat = sat.plus({ days: 7 })
  return { start: sat, end: sat.plus({ days: 1 }).endOf('day') }
}

function endOfMonth(text: string, now: DateTime): DateTime | null {
  const m = text.match(/^(?:by\s+|at\s+)?(?:the\s+)?end\s+of\s+(the|this|next)\s+month$/)
  if (!m) return null
  const base = m[1] === 'next' ? now.plus({ months: 1 }) : now
  return base.endOf('month').startOf('day')
}

// "the 9th" → the next 9th that exists (this month if still ahead, else the next month that has one),
// rewritten as an explicit "9 October 2026" so chrono can read the rest ("at 9am") around it.
function rewriteOrdinal(text: string, now: DateTime): string {
  if (MONTH_NAME.test(text)) return text
  const m = text.match(ORDINAL)
  if (!m) return text
  const day = Number(m[1])
  if (day < 1 || day > 31) return text
  let month = now.startOf('month')
  for (let i = 0; i < 13; i++, month = month.plus({ months: 1 })) {
    if (day > month.daysInMonth!) continue
    const candidate = month.set({ day })
    if (candidate >= now.startOf('day')) return text.replace(m[0], ` ${candidate.toFormat('d LLLL yyyy')} `).replace(/\s+/g, ' ').trim()
  }
  return text
}

interface Parts {
  year?: number
  month?: number
  day?: number
  weekday?: number // 0 = Sunday (chrono)
  hour?: number
  minute?: number
  meridiem?: number
  hourCertain: boolean
  /** A day or weekday was actually said (chrono's `day` for a bare month is only implied). */
  dayKnown: boolean
  covered: number
}

// chrono's hits, merged: a phrase like "friday around 10pm" comes back as TWO results ("friday" and
// "10pm"); taking only the first is how the time of day was lost (T4). Date fields come from the hits
// that know a date, time fields from the hits that know a time.
function chronoParts(text: string, ref: Date, tz: string, forwardDate: boolean): Parts | null {
  const results = localeFor(tz).parse(text, ref, { forwardDate })
  if (results.length === 0) return null
  const out: Parts = { hourCertain: false, dayKnown: false, covered: 0 }
  for (const r of results) {
    const known = (r.start as unknown as { knownValues: Record<string, number> }).knownValues
    const hasDate = 'day' in known || 'weekday' in known || 'month' in known
    const hasTime = 'hour' in known
    if (!hasDate && !hasTime && !DAYPART.test(r.text)) continue
    out.covered += r.text.length
    if (hasDate && out.day === undefined && out.weekday === undefined) {
      if ('day' in known || 'month' in known) {
        out.year = r.start.get('year') ?? undefined
        out.month = r.start.get('month') ?? undefined
        out.day = r.start.get('day') ?? undefined
      }
      if ('weekday' in known && !('day' in known)) out.weekday = known.weekday
      out.dayKnown = 'day' in known || 'weekday' in known
    }
    if (hasTime && out.hour === undefined) {
      out.hour = known.hour
      out.minute = known.minute ?? 0
      out.meridiem = known.meridiem
      out.hourCertain = true
    }
  }
  return out.covered > 0 ? out : null
}

const deadZone = (hour: number) => hour >= 2 && hour < 6

/**
 * Resolve a verbatim time phrase against `now` in the house zone. Null when it is not a time at all
 * (or is a duration). Ranges only for phrases that ARE ranges ("this weekend"); a single day is
 * all-day with no end, a clock time is timed.
 */
export function resolveWhen(raw: string, opts: ResolveOpts): ResolvedWhen | null {
  const now = opts.now.setZone(opts.tz)
  const original = raw.trim()
  if (!original) return null
  let text = normalise(original)
  if (!text || DURATION.test(text)) return null

  const fullCover = { coverage: 1 }
  const weekend = weekendRange(text, now)
  if (weekend) return { start: weekend.start.toJSDate(), end: weekend.end.toJSDate(), allDay: true, exactTime: false, knownDay: true, ...fullCover }
  const eom = endOfMonth(text, now)
  if (eom) return { start: eom.toJSDate(), end: null, allDay: true, exactTime: false, knownDay: true, ...fullCover }

  // "a week before friday" / "2 hours before the party at 9pm": resolve the anchor, then offset it.
  const off = text.match(OFFSET)
  if (off) {
    const n = NUMBER_WORDS[off[1]] ?? Number(off[1])
    const anchor = resolveWhen(off[4], opts)
    if (!anchor || !Number.isFinite(n)) return null
    const sign = off[3] === 'before' ? -1 : 1
    const unit = `${off[2]}s` as 'minutes' | 'hours' | 'days' | 'weeks'
    const shift = (d: Date) => DateTime.fromJSDate(d).setZone(opts.tz).plus({ [unit]: sign * n }).toJSDate()
    return { ...anchor, start: shift(anchor.start), end: null, coverage: 1 }
  }

  // Late at night "tomorrow" is the day that is dawning — the calendar date of now.
  if (now.hour < 4) text = text.replace(/\btomorrow\b/g, 'today')
  text = rewriteOrdinal(text, now)

  const pastMarked = PAST_MARKER.test(text)
  // A Date whose SYSTEM-tz wall clock equals the house's wall clock now, so chrono anchors relative
  // words ("next friday") to the house's today. Only its components are read back.
  const ref = new Date(now.year, now.month - 1, now.day, now.hour, now.minute, now.second)
  const p = chronoParts(text, ref, opts.tz, !pastMarked)
  const daypartMatch = text.match(DAYPART)
  if (!p && !daypartMatch) return null
  const parts: Parts = p ?? { hourCertain: false, dayKnown: false, covered: 0 }
  const coverage = Math.min(1, (parts.covered + (p ? 0 : (daypartMatch?.[0].length ?? 0))) / Math.max(text.length, 1))

  // ── the time of day ───────────────────────────────────────────────────────────────────────────
  let hour: number | null = null
  let minute = 0
  let exactTime = false
  if (parts.hourCertain && parts.hour !== undefined) {
    hour = parts.hour
    minute = parts.minute ?? 0
    exactTime = true
  } else if (daypartMatch) {
    hour = DAYPART_HOURS[daypartMatch[1].toLowerCase()]
  }
  const bareHour = exactTime && parts.meridiem === undefined && hour !== null && hour >= 1 && hour <= 12 && !/\b(noon|midnight)\b/.test(text)

  // ── the day ───────────────────────────────────────────────────────────────────────────────────
  const knownDay = parts.dayKnown
  let date: DateTime | null = null
  if (parts.day !== undefined && parts.month !== undefined) {
    date = DateTime.fromObject({ year: parts.year ?? now.year, month: parts.month, day: parts.day }, { zone: opts.tz })
  } else if (parts.weekday !== undefined) {
    if (pastMarked || /\bnext\b/.test(text)) {
      // chrono's reading of "last sunday" / "next tuesday" — the qualifier decides, not our default.
      const results = localeFor(opts.tz).parse(text, ref, { forwardDate: !pastMarked })
      const hit = results.find((r) => 'weekday' in (r.start as unknown as { knownValues: Record<string, number> }).knownValues)
      if (hit) date = DateTime.fromObject({ year: hit.start.get('year')!, month: hit.start.get('month')!, day: hit.start.get('day')! }, { zone: opts.tz })
    } else {
      const todayWd = now.weekday % 7 // luxon 7 (Sunday) → 0, matching chrono
      const ahead = (parts.weekday - todayWd + 7) % 7
      date = now.startOf('day').plus({ days: ahead })
    }
  }

  if (hour !== null && bareHour && hour < 12) {
    if (date) {
      if (hour <= 7) hour += 12 // "friday at 5" is 17:00
    } else {
      // No day: the next time that hour comes round, am or pm, skipping the 02:00–06:00 dead zone.
      const candidates = [0, 1].flatMap((d) => [hour!, hour! + 12].map((h) => now.startOf('day').plus({ days: d }).set({ hour: h, minute })))
      const next = candidates.filter((c) => c > now && !deadZone(c.hour)).sort((a, b) => a.toMillis() - b.toMillis())[0]
      if (next) {
        date = next.startOf('day')
        hour = next.hour
      }
    }
  }

  if (!date) {
    date = now.startOf('day')
    // A time with no day that has already gone today means tomorrow ("at 7pm" said at 21:00).
    if (hour !== null && !pastMarked && date.set({ hour, minute }) <= now) date = date.plus({ days: 1 })
  } else if (parts.weekday !== undefined && parts.day === undefined && !pastMarked && !/\bnext\b/.test(text)) {
    // The same weekday said ON that day: today while the time is still ahead, else a week on.
    if (date.hasSame(now, 'day') && hour !== null && date.set({ hour, minute }) <= now) date = date.plus({ days: 7 })
  }
  if (!date.isValid) return null

  const allDay = hour === null
  const start = allDay ? date.startOf('day') : date.set({ hour: hour!, minute, second: 0, millisecond: 0 })
  if (!start.isValid) return null
  return { start: start.toJSDate(), end: null, allDay, exactTime, knownDay, coverage }
}

// ── validation of what the MODEL resolved ────────────────────────────────────────────────────────

/** Local ISO ("2026-10-03", "2026-10-03T22:00") in the house zone → DateTime, or null. An explicit
 *  offset in the string is honoured. */
export function parseLocalIso(value: string | null | undefined, tz: string): DateTime | null {
  const v = value?.trim()
  if (!v) return null
  const dt = DateTime.fromISO(v, { zone: tz, setZone: false })
  return dt.isValid ? dt.setZone(tz) : null
}

const withinRange = (dt: DateTime, now: DateTime) => Math.abs(dt.diff(now, 'years').years) <= MAX_YEARS_OUT

export interface EventWindow {
  /** facts.event_at — when it starts. */
  eventAt: Date
  /** facts.valid_to — when it is over (the fact stops being "current" then; T2). */
  validTo: Date
}

/**
 * A fact's `when {start, end?, allDay}` as the extractor returned it → event_at + valid_to (spec §6):
 * valid_to = end ?? (allDay ? end of that day : start + 6h). Null when the start is unparseable or more
 * than MAX_YEARS_OUT away. An end before the start is a misread and is dropped (the default applies).
 * A start with no time part is all-day WHATEVER the (optional) flag says — mirroring fireAtFromModel.
 * Read as a timed event at local midnight it would expire at 06:00 on the day itself: "when does Zosia
 * arrive?" asked that morning would find nothing, and the morning-of heads-up would be dropped.
 */
export function eventWindowFromModel(when: { start: string; end?: string | null; allDay?: boolean } | null | undefined, tz: string, now: Date): EventWindow | null {
  if (!when) return null
  const nowDt = DateTime.fromJSDate(now).setZone(tz)
  const startRaw = parseLocalIso(when.start, tz)
  if (!startRaw || !withinRange(startRaw, nowDt)) return null
  const allDay = when.allDay === true || !/T\d/.test(when.start)
  const start = allDay ? startRaw.startOf('day') : startRaw
  const endRaw = parseLocalIso(when.end ?? null, tz)
  let end: DateTime | null = endRaw ? (allDay || !/T/.test(when.end ?? '') ? endRaw.endOf('day') : endRaw) : null
  if (end && (end < start || !withinRange(end, nowDt))) end = null
  return { eventAt: start.toJSDate(), validTo: (end ?? defaultEnd(start, allDay)).toJSDate() }
}

const defaultEnd = (start: DateTime, allDay: boolean) => (allDay ? start.endOf('day') : start.plus({ hours: DEFAULT_EVENT_HOURS }))

/** The same window from the chrono fallback's reading of a phrase. */
export function eventWindowFromResolved(r: ResolvedWhen, tz: string): EventWindow {
  const start = DateTime.fromJSDate(r.start).setZone(tz)
  const end = r.end ? DateTime.fromJSDate(r.end).setZone(tz) : defaultEnd(start, r.allDay)
  return { eventAt: start.toJSDate(), validTo: end.toJSDate() }
}

/** A fact's time phrase via the fallback resolver → its window (live capture, whenText only). */
export function eventWindowFromPhrase(phrase: string | null | undefined, tz: string, now: Date): EventWindow | null {
  if (!phrase?.trim()) return null
  const nowDt = DateTime.fromJSDate(now).setZone(tz)
  const r = resolveWhen(phrase, { tz, now: nowDt })
  if (!r || !withinRange(DateTime.fromJSDate(r.start), nowDt)) return null
  return eventWindowFromResolved(r, tz)
}

/** A reminder's `fireAt` as the extractor returned it → an instant, or null (unparseable / too far). A
 *  date without a time fires at DEFAULT_REMINDER_HOUR. */
export function fireAtFromModel(fireAt: string | null | undefined, tz: string, now: Date): Date | null {
  const dt = parseLocalIso(fireAt, tz)
  if (!dt || !withinRange(dt, DateTime.fromJSDate(now).setZone(tz))) return null
  return (/T\d/.test(fireAt ?? '') ? dt : dt.set({ hour: DEFAULT_REMINDER_HOUR, minute: 0 })).toJSDate()
}

export interface ReminderTime {
  fireAt: Date
  /** Only a default filled the time of day (a bare date, or a daypart) — if that has already passed
   *  today, the right move is to ask for a time, not to call the request "past". */
  timeDefaulted: boolean
}

/** A reminder's time phrase via the fallback resolver. A bare date fires at DEFAULT_REMINDER_HOUR. */
export function reminderTimeFromPhrase(phrase: string | null | undefined, tz: string, now: Date): ReminderTime | null {
  if (!phrase?.trim()) return null
  const nowDt = DateTime.fromJSDate(now).setZone(tz)
  const r = resolveWhen(phrase, { tz, now: nowDt })
  if (!r || !withinRange(DateTime.fromJSDate(r.start), nowDt)) return null
  let start = DateTime.fromJSDate(r.start).setZone(tz)
  // "this weekend" said on the Sunday starts yesterday — a reminder for it means the part still ahead.
  if (r.end && start < nowDt) start = nowDt.startOf('day')
  const fireAt = r.allDay ? start.set({ hour: DEFAULT_REMINDER_HOUR, minute: 0 }) : start
  return { fireAt: fireAt.toJSDate(), timeDefaulted: !r.exactTime }
}

/** How far apart two instants are, in minutes — the model-vs-chrono cross-check. */
export const minutesApart = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000
