import { DateTime } from 'luxon'
import type { OlympicsRefusal, OlympicsResult } from './client'

// The DETERMINISTIC half of the Olympics intents (docs/spec/olympics.md): the extractor
// (lib/ai/olympics-extract.ts) PROPOSES an op and its slots from the message; this code DISPOSES —
// validates the event's date and times, resolves a chore description to exactly one chore Olympics
// listed, and renders every line Baumy says about it. No model ever words an Olympics answer, and no
// model output reaches Olympics without passing through here.

export type OlympicsOp = 'calendar_add' | 'calendar_list' | 'chore_log' | 'standings'

/** The confirm-gated writes Baumy may propose, and the Olympics action each one calls. */
export const OLYMPICS_WRITE_ACTIONS = { calendar_add: 'create_event', chore_log: 'log_completion' } as const
export type OlympicsWriteOp = keyof typeof OLYMPICS_WRITE_ACTIONS

/** What a confirm card stores (pending_actions, type `olympics.action`) — everything the TAP needs. */
export interface OlympicsPending {
  op: OlympicsWriteOp
  name: (typeof OLYMPICS_WRITE_ACTIONS)[OlympicsWriteOp]
  input: Record<string, unknown>
  /** Minted at propose time and reused by every retry of the tap — so Olympics runs it once. */
  idempotencyKey: string
  /** One line naming what the tap does (the card, the audit row). */
  summary: string
}

// ── The fixed lines ──────────────────────────────────────────────────────────────────────────────

export const LINK_FIRST =
  "I don't know who you are in Baumy Olympics yet. Open Olympics → Settings → Create a link code, then DM me /link <code> — after that I can add events and log chores for you. 🔗"
export const NOT_CONNECTED = "Baumy Olympics isn't connected to me yet — the house owner needs to set that up. 🐈‍⬛"
export const UNAVAILABLE = "Baumy Olympics isn't answering right now — try again in a minute. 🐈‍⬛"

/** Why nothing can go ahead, in words, for any failed Olympics call. */
export function failureLine(r: Exclude<OlympicsResult<unknown>, { ok: true }>): string {
  if (r.kind === 'not_configured') return NOT_CONNECTED
  if (r.kind === 'unavailable') return UNAVAILABLE
  return refusalLine(r)
}

function refusalLine(r: OlympicsRefusal): string {
  if (r.code === 'TELEGRAM_NOT_LINKED') return LINK_FIRST
  // Olympics writes `message` for people (docs/brain-integration.md §Answers).
  return `⚠️ ${r.message}`
}

// ── Calendar: validate an event before it is ever proposed ─────────────────────────────────────

/** The slots the extractor proposes for a new event (strings; '' = not said). */
export interface EventSlots {
  title?: string
  date?: string
  endDate?: string
  startTime?: string
  endTime?: string
  location?: string
}

/** The `create_event` input (Olympics' schema: Berlin days and wall-clock times). */
export interface CreateEventInput {
  title: string
  kind: 'timed' | 'all_day'
  date: string
  endDate?: string
  startTime?: string
  endTime?: string
  location?: string
}

export type EventDraft =
  | { ok: true; input: CreateEventInput; when: string }
  | { ok: false; reason: 'no_title' | 'no_date' | 'bad_date' | 'past' | 'too_far' }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
/** A timed event with no end is an hour long (said on the card, so a wrong guess is visible). */
export const DEFAULT_EVENT_MINUTES = 60
const MAX_YEARS_OUT = 2

const day = (s: string | undefined, tz: string): DateTime | null => {
  if (!s || !DAY.test(s.trim())) return null
  const d = DateTime.fromISO(s.trim(), { zone: tz })
  return d.isValid ? d.startOf('day') : null
}

/** "7:00" / "19.00" / "19:00:00" → "19:00"; anything else → null. */
export function normaliseTime(s: string | undefined): string | null {
  const m = (s ?? '').trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/)
  if (!m) return null
  const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`
  return HHMM.test(hhmm) ? hhmm : null
}

export function buildEventInput(slots: EventSlots, now: Date, tz: string): EventDraft {
  const title = (slots.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!title) return { ok: false, reason: 'no_title' }
  if (!(slots.date ?? '').trim()) return { ok: false, reason: 'no_date' }
  const start = day(slots.date, tz)
  if (!start) return { ok: false, reason: 'bad_date' }
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day')
  if (start < today) return { ok: false, reason: 'past' }
  if (start > today.plus({ years: MAX_YEARS_OUT })) return { ok: false, reason: 'too_far' }
  let end = (slots.endDate ?? '').trim() ? day(slots.endDate, tz) : null
  if ((slots.endDate ?? '').trim() && (!end || end < start)) return { ok: false, reason: 'bad_date' }
  const location = (slots.location ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const base = { title, date: start.toISODate()!, ...(location ? { location } : {}) }

  const startTime = normaliseTime(slots.startTime)
  if (!startTime) {
    // No time of day said: a whole-day event.
    const input: CreateEventInput = { ...base, kind: 'all_day', ...(end && end > start ? { endDate: end.toISODate()! } : {}) }
    return { ok: true, input, when: describeWhen(input, tz) }
  }
  const startAt = DateTime.fromISO(`${base.date}T${startTime}`, { zone: tz })
  if (startAt.toMillis() < now.getTime()) return { ok: false, reason: 'past' }
  let endTime = normaliseTime(slots.endTime)
  if (!endTime) {
    const e = startAt.plus({ minutes: DEFAULT_EVENT_MINUTES })
    endTime = e.toFormat('HH:mm')
    if (!end) end = e.startOf('day')
  }
  // "22:00–01:00" with no end day said: it ends the next day.
  if (!end) end = endTime <= startTime ? start.plus({ days: 1 }) : start
  if (end.hasSame(start, 'day') && endTime <= startTime) end = start.plus({ days: 1 })
  const input: CreateEventInput = {
    ...base,
    kind: 'timed',
    startTime,
    endTime,
    ...(end.hasSame(start, 'day') ? {} : { endDate: end.toISODate()! }),
  }
  return { ok: true, input, when: describeWhen(input, tz) }
}

const fmtDay = (d: string, tz: string) => DateTime.fromISO(d, { zone: tz }).toFormat('ccc d LLL')

/** "Sat 3 Oct, 19:00–20:00" · "Sat 3 Oct 22:00 – Sun 4 Oct 01:00" · "Sat 3 Oct, all day". */
export function describeWhen(i: CreateEventInput, tz: string): string {
  const first = fmtDay(i.date, tz)
  const last = i.endDate && i.endDate !== i.date ? fmtDay(i.endDate, tz) : null
  if (i.kind === 'all_day') return last ? `${first} – ${last}, all day` : `${first}, all day`
  return last ? `${first} ${i.startTime} – ${last} ${i.endTime}` : `${first}, ${i.startTime}–${i.endTime}`
}

export function eventDraftProblem(reason: Extract<EventDraft, { ok: false }>['reason']): string {
  switch (reason) {
    case 'no_title':
      return 'What should I call the event? Something like "add dinner with Anna Saturday 19:00". 📅'
    case 'no_date':
      return 'Which day is it on? Say it like "add dinner with Anna Saturday 19:00". 📅'
    case 'bad_date':
      return "I couldn't read that date — try it like \"Saturday 19:00\" or \"3 Oct\". 📅"
    case 'past':
      return "That time has already passed, so I didn't add it. 📅"
    case 'too_far':
      return "That's more than two years out — I only add events up to two years ahead. 📅"
  }
}

export function eventCard(i: CreateEventInput, when: string): string {
  const where = i.location ? `\n📍 ${i.location}` : ''
  return `Add this to the house calendar?\n📅 ${i.title}\n🕒 ${when}${where}\n\nTap to confirm.`
}

// ── Calendar: what's on ──────────────────────────────────────────────────────────────────────────

export interface EventView {
  id: string
  title: string
  location: string | null
  allDay: boolean
  startDate: string
  endDate: string
  startTime: string | null
  endTime: string | null
  /** Olympics' own "Fri 15 Jan, 19:00–20:30". */
  when: string
}
export interface ListEventsData {
  from: string
  to: string
  events: EventView[]
}

export const DEFAULT_LIST_DAYS = 7
const MAX_LIST_DAYS = 62

/** The `list_events` range: the model's days when they read, else the next week (Olympics caps 62). */
export function listRange(slots: { from?: string; to?: string }, now: Date, tz: string): { from: string; to: string } {
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day')
  const from = day(slots.from, tz) ?? today
  let to = day(slots.to, tz) ?? (day(slots.from, tz) ? from : from.plus({ days: DEFAULT_LIST_DAYS - 1 }))
  if (to < from) to = from
  if (to.diff(from, 'days').days > MAX_LIST_DAYS) to = from.plus({ days: MAX_LIST_DAYS })
  return { from: from.toISODate()!, to: to.toISODate()! }
}

export function renderEvents(d: ListEventsData, tz: string): string {
  const range = d.from === d.to ? fmtDay(d.from, tz) : `${fmtDay(d.from, tz)} – ${fmtDay(d.to, tz)}`
  if (d.events.length === 0) return `Nothing on the house calendar for ${range}. 📅`
  const lines = d.events.slice(0, 20).map((e) => `• ${e.when} — ${e.title}${e.location ? ` (${e.location})` : ''}`)
  const more = d.events.length > 20 ? `\n…and ${d.events.length - 20} more in Olympics.` : ''
  return `📅 House calendar, ${range}:\n${lines.join('\n')}${more}`
}

// ── Chores ──────────────────────────────────────────────────────────────────────────────────────

export interface ChoreView {
  id: string
  name: string
  archived: boolean
  basePoints: number | null
  state: 'due' | 'cooldown' | 'done' | 'unavailable'
  availableAt: string | null
  next: { totalPts: number; streakLen: number } | null
}
export interface ListChoresData {
  chores: ChoreView[]
}

// Words that name no chore ("I took the trash out" → "trash"). Matching is by the remaining words.
const STOP = new Set(
  'a an the i we my our me us you to of for on in at up out off did do done just took take taken have has had been finally all some it this that and with from again today now'.split(
    ' ',
  ),
)
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '') || w
const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)

export type ChoreMatch = { kind: 'one'; chore: ChoreView } | { kind: 'none' } | { kind: 'ambiguous'; chores: ChoreView[] }

/** Resolve the extractor's chore description to exactly one listed (unarchived) chore, or say why not. */
export function matchChore(chores: ChoreView[], description: string): ChoreMatch {
  const live = chores.filter((c) => !c.archived)
  const want = words(description)
  if (want.length === 0) return { kind: 'none' }
  const exact = live.filter((c) => words(c.name).join(' ') === want.join(' '))
  if (exact.length === 1) return { kind: 'one', chore: exact[0] }
  const scored = live
    .map((c) => {
      const have = new Set(words(c.name))
      return { c, score: want.filter((w) => have.has(w)).length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return { kind: 'none' }
  const top = scored.filter((x) => x.score === scored[0].score)
  return top.length === 1 ? { kind: 'one', chore: top[0].c } : { kind: 'ambiguous', chores: top.map((x) => x.c) }
}

const choreNames = (cs: ChoreView[]) =>
  cs
    .slice(0, 12)
    .map((c) => `• ${c.name}`)
    .join('\n')

export function choreNotFound(chores: ChoreView[], description: string): string {
  const live = chores.filter((c) => !c.archived)
  if (live.length === 0) return 'There are no chores in Baumy Olympics yet — an admin adds them there. 🧹'
  const what = description.trim() ? `"${description.trim()}"` : 'that'
  return `I couldn't match ${what} to a chore. The chores are:\n${choreNames(live)}\n\nSay which one, like "I did the ${live[0].name.toLowerCase()}". 🧹`
}

export function choreAmbiguous(chores: ChoreView[]): string {
  return `Which one?\n${choreNames(chores)}\n\nSay it again with the chore's name. 🧹`
}

/** A chore that cannot be logged right now (so no card is shown), or null when it can. */
export function choreBlocked(c: ChoreView, now: Date, tz: string): string | null {
  if (c.state === 'unavailable' || c.basePoints == null) return `${c.name} can't be scored yet — it has no points set in Olympics. 🧹`
  if (c.state === 'cooldown') {
    const at = c.availableAt ? DateTime.fromISO(c.availableAt).setZone(tz) : null
    const when = at?.isValid ? (at.hasSame(DateTime.fromJSDate(now).setZone(tz), 'day') ? at.toFormat('HH:mm') : at.toFormat('ccc d LLL HH:mm')) : 'a bit later'
    return `${c.name} was done recently — it can be logged again from ${when}. 🧹`
  }
  return null
}

export function choreCard(c: ChoreView): string {
  const pts = c.next ? ` — +${c.next.totalPts} point${c.next.totalPts === 1 ? '' : 's'}${c.next.streakLen > 1 ? ` (streak ${c.next.streakLen})` : ''}` : ''
  return `Log this chore for you?\n🧹 ${c.name}${pts}\n\nTap to confirm.`
}

// ── Standings ──────────────────────────────────────────────────────────────────────────────────

export interface GetStandingsData {
  season: { year: number }
  leaderId: string | null
  standings: { memberId: string; displayName: string; rank: number; points: number; provisionalPts: number }[]
}

export function renderStandings(d: GetStandingsData): string {
  if (d.standings.length === 0) return `No points yet in the ${d.season.year} season. 🏆`
  const lines = d.standings.map((s) => {
    const prov = s.provisionalPts > 0 ? ` (${s.provisionalPts} still open to dispute)` : ''
    return `${s.rank}. ${s.displayName} — ${s.points} pt${s.points === 1 ? '' : 's'}${prov}`
  })
  const leader = d.standings.find((s) => s.memberId === d.leaderId)
  const head = leader ? `${leader.displayName} leads` : 'Nobody leads outright'
  return `🏆 ${d.season.year} standings — ${head}:\n${lines.join('\n')}`
}

// ── After the tap ──────────────────────────────────────────────────────────────────────────────

/** The card's text once the tap ran (`result` is the memoized Olympics answer). */
export function tapResultLine(p: OlympicsPending, result: OlympicsResult<unknown>): string {
  if (!result.ok) return failureLine(result)
  if (p.op === 'calendar_add') {
    const e = (result.data as { event?: { title?: string; when?: string } } | null)?.event
    return `✅ Added to the house calendar: ${e?.title ?? String(p.input.title ?? 'the event')}${e?.when ? ` — ${e.when}` : ''}`
  }
  const d = (result.data ?? {}) as { choreName?: string; counted?: boolean; totalPts?: number | null }
  const pts = d.counted && d.totalPts != null ? ` — +${d.totalPts} point${d.totalPts === 1 ? '' : 's'}` : ''
  return `✅ Logged: ${d.choreName ?? p.summary}${pts} 🧹`
}
