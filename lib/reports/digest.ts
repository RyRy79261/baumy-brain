import { and, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { reminders, memoryItems } from '@/db/schema'
import { houseTz } from '@/lib/env'
import { now as clockNow } from '@/lib/core/clock'
import { formatEventWindow } from '@/lib/core/calendar'
import { upcomingDatedFacts } from '@/lib/memory/facts'
import { memberDisplayNames } from '@/lib/identity/roster'
import { describeRecurrence } from '@/lib/reminders/recurrence'

// What /weekly is about (T5), gathered FROM DB records (never chat recall) and every line DATED:
//   • notes of kind statement/fact said in the LAST 7 DAYS — never a question someone asked or chatter
//     (those are not house news), never a months-old note (a quiet house used to get June's "the
//     party is tomorrow night" in its weekly digest, read against today);
//   • explicit reminders coming up in the next two weeks, with their day + time (and repeat rule);
//   • dated events coming up (current facts with an event_at), with the EVENT's date — not a heads-up
//     reminder's fire date next to text that already says "tomorrow".
// Secure values and quarantined (forwarded/bot) content are never included.
export const WEEKLY_LOOKBACK_DAYS = 7
const HORIZON_DAYS = 14
const NEWS_KINDS = ['statement', 'fact']

export interface WeeklyMaterial {
  notes: { content: string; at: Date; by: string | null }[]
  reminders: { content: string; fireAt: Date; recurrence: string | null }[]
  events: { text: string; eventAt: Date; validTo: Date | null; by: string | null }[]
}

export async function gatherWeekly(db: Database, groupId: string, now: Date = clockNow()): Promise<WeeklyMaterial> {
  const since = new Date(now.getTime() - WEEKLY_LOOKBACK_DAYS * 86_400_000)
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86_400_000)
  const names = await memberDisplayNames(db)
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null)

  const notes = await db
    .select({ content: memoryItems.content, at: memoryItems.createdAt, by: memoryItems.authoredBy })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.groupId, groupId),
        eq(memoryItems.isActive, true),
        eq(memoryItems.isSecure, false),
        ne(memoryItems.trustLevel, 'quarantined'),
        inArray(memoryItems.memoryType, NEWS_KINDS),
        gte(memoryItems.createdAt, since),
        lte(memoryItems.createdAt, now),
      ),
    )
    .orderBy(desc(memoryItems.createdAt))
    .limit(20)

  const upcoming = await db
    .select({ content: reminders.content, fireAt: reminders.fireAt, recurrence: reminders.recurrence })
    .from(reminders)
    .where(
      and(
        eq(reminders.groupId, groupId),
        eq(reminders.status, 'scheduled'),
        ne(reminders.anchorKind, 'event_offset'), // the events themselves come from the facts below
        gte(reminders.fireAt, now),
        lte(reminders.fireAt, horizon),
      ),
    )
    .orderBy(reminders.fireAt)
    .limit(12)

  const dated = await upcomingDatedFacts(db, groupId, now, horizon)
  return {
    notes: notes.map((n) => ({ content: n.content, at: new Date(n.at), by: nameOf(n.by) })),
    reminders: upcoming.map((u) => ({ content: u.content, fireAt: new Date(u.fireAt), recurrence: u.recurrence })),
    events: dated.slice(0, 12).map((f) => ({
      text: `${f.subject} ${f.predicate.replace(/_/g, ' ')}${f.objectValue ? `: ${f.objectValue}` : ''}`,
      eventAt: f.eventAt,
      validTo: f.validTo,
      by: nameOf(f.authoredBy),
    })),
  }
}

export const isEmptyWeek = (m: WeeklyMaterial) => !m.notes.length && !m.reminders.length && !m.events.length

const day = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat('ccc d LLL')
const dayTime = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat('ccc d LLL HH:mm')

/** The dated grounding lines the /weekly model is given (and the deterministic digest reuses). */
export function weeklyLines(m: WeeklyMaterial, tz: string = houseTz()): { lately: string[]; comingUp: string[] } {
  const repeat = (r: string | null) => {
    const d = describeRecurrence(r)
    return d ? ` (repeats ${d})` : ''
  }
  return {
    lately: m.notes.map((n) => `- noted ${day(n.at, tz)}${n.by ? ` by ${n.by}` : ''}: ${n.content}`),
    comingUp: [
      ...m.events.map((e) => ({ at: e.eventAt, line: `- event ${formatEventWindow(e.eventAt, e.validTo, tz)}${e.by ? ` (per ${e.by})` : ''}: ${e.text}` })),
      ...m.reminders.map((r) => ({ at: r.fireAt, line: `- reminder ${dayTime(r.fireAt, tz)}: ${r.content}${repeat(r.recurrence)}` })),
    ]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((x) => x.line),
  }
}

// The deterministic house digest — the /weekly fallback when the model's output is unusable or the
// provider permanently refuses. No LLM, so it is cheap, safe, and can never fabricate house state.
export async function buildDigest(db: Database, groupId: string, now: Date = clockNow()): Promise<string> {
  const tz = houseTz()
  const m = await gatherWeekly(db, groupId, now)
  const { lately, comingUp } = weeklyLines(m, tz)
  const bullet = (l: string) => `• ${l.replace(/^- /, '')}`
  const lines: string[] = ['🌳 House digest']
  if (comingUp.length > 0) lines.push('', 'Coming up:', ...comingUp.map(bullet))
  if (lately.length > 0) lines.push('', 'This past week:', ...lately.map(bullet))
  if (isEmptyWeek(m)) lines.push('', 'Nothing on file this week.')
  return lines.join('\n')
}
