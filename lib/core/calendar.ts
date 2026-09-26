import { DateTime } from 'luxon'
import { now } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'

// The time anchor every extraction prompt carries (docs/spec/chat-understanding-v2.md §6): WHEN the
// message was sent, in the house timezone, plus a 21-day calendar table (date ↔ weekday, starting
// yesterday). With both, a model resolves "this weekend", "friday around 10pm" or "the 9th" by LOOKING
// UP a row instead of doing calendar arithmetic in its head — the arithmetic is what it gets wrong.
//
// Pure formatting over an explicit instant (default: the clock seam, so a sandbox sees its own day).

/** How many days the table covers: yesterday + today + 19 ahead. */
export const CALENDAR_DAYS = 21

/** `MESSAGE SENT: Fri 26 Sep 2026 21:40 Europe/Berlin` */
export function messageSentLine(at: Date = now(), tz: string = houseTz()): string {
  return `MESSAGE SENT: ${DateTime.fromJSDate(at).setZone(tz).toFormat('ccc d LLL yyyy HH:mm')} ${tz}`
}

/**
 * The calendar table: one row per day from yesterday, `Sat 2026-09-26 (today)`. The ISO date is on the
 * row so the model can copy it straight into a local-ISO answer. The house's own "today" (tz-local), not
 * the server's — a message at 00:30 Berlin is on the Berlin date.
 */
export function calendarTable(at: Date = now(), tz: string = houseTz(), days = CALENDAR_DAYS): string[] {
  const today = DateTime.fromJSDate(at).setZone(tz).startOf('day')
  const label = (offset: number) => (offset === -1 ? ' (yesterday)' : offset === 0 ? ' (today)' : offset === 1 ? ' (tomorrow)' : '')
  const rows: string[] = []
  for (let i = -1; i < days - 1; i++) {
    const d = today.plus({ days: i })
    rows.push(`${d.toFormat('ccc yyyy-LL-dd')}${label(i)}`)
  }
  return rows
}

/** Both, as the block the fact and reminder extractors are given. */
export function timeContext(at: Date = now(), tz: string = houseTz()): string {
  return [messageSentLine(at, tz), 'CALENDAR (house time; look dates up here, do not compute them):', ...calendarTable(at, tz).map((r) => `  ${r}`)].join('\n')
}

// The resolution rules the extractors are told, stated ONCE so the fact and reminder prompts (and the
// deterministic fallback in lib/core/when.ts, which implements the same defaults) agree.
export const TIME_RULES = [
  'Resolve every time against MESSAGE SENT using the CALENDAR rows — never guess a weekday or do date arithmetic in your head.',
  'Defaults when a phrase is vague: morning 09:00, noon 12:00, afternoon 15:00, evening and tonight 20:00, night 22:00. A bare clock hour with no am/pm ("at 5") is the NEXT time that hour comes round (17:00 when said at 14:00; with a day named, 1–7 means pm).',
  'A weekday name is its next occurrence; the same weekday said ON that day means today if the time is still ahead. "This weekend" said on a Saturday or Sunday is the CURRENT weekend. "The 9th" is the next 9th of a month.',
  'Late at night (00:00–04:00) people still mean the evening they are in: "tomorrow" then means the CALENDAR row marked (today) — the day that is dawning.',
  'Dates written with slashes are day/month (9/10 = 9 October), unless the house timezone is in the Americas.',
].join(' ')

// How an event's window is shown to a model or a housemate: "Sat 3 Oct", "Sat 3 Oct 22:00",
// "Sat 3 Oct – Sun 4 Oct". An all-day start is local midnight (lib/core/when.ts); the end is shown only
// when it falls on a later day than the start — and for a timed event only when it runs past a day
// (the default +6h end of a 22:00 party is noise, not a range).
export function formatEventWindow(eventAt: Date, validTo: Date | null | undefined, tz: string = houseTz(), opts: { year?: boolean } = {}): string {
  const s = DateTime.fromJSDate(eventAt).setZone(tz)
  const fmt = opts.year ? 'ccc d LLL yyyy' : 'ccc d LLL'
  const timed = s.hour !== 0 || s.minute !== 0
  const head = `${s.toFormat(fmt)}${timed ? ` ${s.toFormat('HH:mm')}` : ''}`
  if (!validTo || (timed && validTo.getTime() - eventAt.getTime() <= 86_400_000)) return head
  // An all-day end is 23:59:59.999 of its last day; a timed end at exactly midnight belongs to the day before.
  const e = DateTime.fromJSDate(validTo).setZone(tz).minus({ milliseconds: 1 })
  return e.startOf('day') > s.startOf('day') ? `${head} – ${e.toFormat(fmt)}` : head
}
