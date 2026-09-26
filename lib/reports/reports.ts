import { and, eq, gte, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { reminders } from '@/db/schema'
import { resolveModel } from '@/lib/ai/registry'
import { WEEKLY_REPORT_SYSTEM, GUEST_REPORT_SYSTEM } from '@/lib/ai/prompts'
import { retrieve } from '@/lib/memory/retrieve'
import { currentFactsForQuery } from '@/lib/memory/facts'
import { liveFact } from '@/lib/memory/current'
import { buildDigest, gatherWeekly, isEmptyWeek, weeklyLines, WEEKLY_LOOKBACK_DAYS } from '@/lib/reports/digest'
import { houseToday, now as clockNow } from '@/lib/core/clock'
import { formatEventWindow } from '@/lib/core/calendar'
import { describeRecurrence } from '@/lib/reminders/recurrence'
import { visibleReminders } from '@/lib/reminders/store'
import { houseTz } from '@/lib/env'
import { textFallbackAllowed } from '@/lib/ai/errors'

// On-demand house reports (owner feature): a slash command generates a formatted report
// from house memory. LLM-formatted (the data is free-form facts + notes) but grounded
// STRICTLY in what's stored — never invents — and degrades to a deterministic list when the
// model's output is unusable or the provider permanently refuses. A transient provider error rethrows so the report step retries (I2). Secure values + quarantined (forwarded/bot) content are excluded.
export type HouseReport = 'weekly' | 'guests' | 'reminders' | 'recent'

// Detect a report slash command (/weekly, /guests, /reminders, /recent) at the start of a message.
// Works in the house group OR a DM; deterministic, no false positives; strips a @botname suffix.
// /reminders + /recent are the read-only introspection read-outs (docs/spec/telegram.md D9c).
export function parseHouseReport(text: string | null | undefined): HouseReport | null {
  if (!text) return null
  const m = text.trim().match(/^\/(weekly|guests|reminders|recent)(?:@\w+)?\b/i)
  return m ? (m[1].toLowerCase() as HouseReport) : null
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}
const day = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat('ccc d LLL')

// "What's been happening": the last 7 days' dated news + what's coming up, each line with its date
// (lib/reports/digest.ts gatherWeekly — T5), written as a short friendly digest. Falls back to the
// deterministic buildDigest when the model's output is unusable.
export async function weeklyReport(db: Database, groupId: string, now: Date = clockNow()): Promise<string> {
  const tz = houseTz()
  const m = await gatherWeekly(db, groupId, now)
  if (isEmptyWeek(m)) return 'Pretty quiet lately — nothing much on file 😺'
  const { lately, comingUp } = weeklyLines(m, tz)
  const grounding = [
    `THIS PAST WEEK (${WEEKLY_LOOKBACK_DAYS} days; each line dated when it was said):`,
    ...(lately.length ? lately : ['- (nothing new noted)']),
    'COMING UP (each line dated when it happens):',
    ...(comingUp.length ? comingUp : ['- (nothing scheduled)']),
  ].join('\n')
  try {
    const { text } = await generateText({
      model: resolveModel('assess'),
      system: WEEKLY_REPORT_SYSTEM,
      prompt: `TODAY: ${houseToday(now)}\n\nHOUSE MEMORY (your ONLY source):\n${grounding}`,
    })
    const t = text.trim()
    return t || (await buildDigest(db, groupId, now))
  } catch (err) {
    if (!textFallbackAllowed(err)) throw err
    console.error('weeklyReport: model output unusable or refused — deterministic digest:', err)
    return buildDigest(db, groupId, now)
  }
}

// Notes older than this never ground /guests: a guest is a dated thing, and an old note's "this
// weekend" is somebody else's weekend.
const GUEST_NOTE_DAYS = 30

// "Who's in which room over the next month": CURRENT stay/room/arrival facts with their date ranges
// (an expired stay — a visit that is over — is excluded, T2), plus recent dated notes, assembled into
// a room-by-room / person-by-person report. Falls back to the raw list when the model's output is unusable.
export async function guestReport(db: Database, groupId: string, now: Date = clockNow()): Promise<string> {
  const tz = houseTz()
  // Directly pull facts about staying / rooms / arrivals (the structured half), soonest first.
  const stayFacts = rowsOf(
    await db.execute(sql`
      SELECT e.canonical_name AS subject, f.predicate AS predicate, f.object_value AS "objectValue",
             f.event_at AS "eventAt", f.valid_to AS "validTo", f.recorded_at AS "recordedAt"
      FROM baumy_facts f JOIN baumy_entities e ON f.subject_entity_id = e.id
      WHERE f.group_id = ${groupId} AND ${liveFact('f', now)} AND f.is_secure = false AND f.object_value IS NOT NULL
        AND (
          f.predicate ILIKE '%stay%' OR f.predicate ILIKE '%sleep%' OR f.predicate ILIKE '%room%'
          OR f.predicate ILIKE '%arriv%' OR f.predicate ILIKE '%visit%' OR f.predicate ILIKE '%guest%'
          OR f.object_value ~* '\y(room|bedroom|cave|lounge)\y'  -- whole words: not "mushroom"/"concave"
        )
      ORDER BY f.event_at ASC NULLS LAST, f.recorded_at DESC
      LIMIT 30`),
  )
  // Semantic/lexical half — raw notes about guests/rooms/arrivals, recent ones only, each dated.
  let mems: Awaited<ReturnType<typeof retrieve>> = []
  try {
    mems = await retrieve('guests staying visiting bedroom room cave arriving this month next few weeks', { groupId, k: 20, floor: 0.05 }, { db })
  } catch {
    /* best-effort */
  }
  const noteSince = now.getTime() - GUEST_NOTE_DAYS * 86_400_000
  const facts = await currentFactsForQuery(db, groupId, 'guest staying room bedroom cave arriving visiting who is in', 20)

  const dates = (eventAt: unknown, validTo: unknown, recordedAt: unknown) =>
    eventAt
      ? ` (${formatEventWindow(new Date(eventAt as string), validTo ? new Date(validTo as string) : null, tz)})`
      : recordedAt
        ? ` (no dates given; said ${day(recordedAt as string, tz)})`
        : ''
  const lines = [
    ...stayFacts.map((r) => `- ${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}: ${(r.objectValue as string) ?? ''}${dates(r.eventAt, r.validTo, r.recordedAt)}`),
    ...facts.filter((f) => !f.isSecure).map((f) => `- ${f.content}${dates(f.eventAt, f.validTo, f.recordedAt)}`),
    ...mems
      .filter((m) => !m.isSecure && m.createdAt && new Date(m.createdAt).getTime() >= noteSince && !['question', 'chatter', 'banter'].includes(m.memoryType))
      .map((m) => `- note said ${day(m.createdAt!, tz)}: ${m.content}`),
  ]
  const grounding = [...new Set(lines)].join('\n')
  if (!grounding) return 'No guests on the books that I know of — the house is all yours 😺'

  try {
    const { text } = await generateText({
      model: resolveModel('assess'),
      system: GUEST_REPORT_SYSTEM,
      prompt: `TODAY: ${houseToday(now)}\n\nHOUSE MEMORY (your ONLY source; dates in brackets):\n${grounding}`,
    })
    return text.trim() || `Here's what I've got on guests:\n${grounding}`
  } catch (err) {
    if (!textFallbackAllowed(err)) throw err
    console.error('guestReport: model output unusable or refused — raw list:', err)
    return `Here's what I've got on guests:\n${grounding}`
  }
}

// House-local "Wed 3 Sep, 09:00" for a reminder's fire time (reminders have a time, unlike dated facts).
const fmtDateTime = (d: Date | string, tz: string) =>
  DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat('ccc d LLL, HH:mm')

// Introspection read-out: everything scheduled and still to come (docs/spec/telegram.md D9c). PURELY
// DETERMINISTIC — a direct read of the reminders table, no model, no cost. Reminders aren't secret,
// but this reads only status='scheduled' rows so it never leaks cancelled/sent noise. 🗓️ marks an
// event heads-up, ⏰ an explicit reminder — matching how they'll actually post.
// `privateTo` = the member asking in their own DM: their personal DM reminders (D2) are listed too,
// marked as just theirs. In the group (null) only house reminders are — a personal one stays private.
export async function upcomingRemindersReport(
  db: Database,
  groupId: string,
  tz: string,
  now: Date = clockNow(),
  privateTo: string | null = null,
): Promise<string> {
  const rows = await db
    .select({
      content: reminders.content,
      fireAt: reminders.fireAt,
      anchorKind: reminders.anchorKind,
      recurrence: reminders.recurrence,
      personal: sql<boolean>`${reminders.deliverChatId} <> ${reminders.groupId}`,
    })
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), visibleReminders(privateTo), eq(reminders.status, 'scheduled'), gte(reminders.fireAt, now)))
    .orderBy(reminders.fireAt)
    .limit(25)
  if (rows.length === 0) return 'Nothing on the calendar right now — all clear 😺'
  const lines = rows.map((r) => {
    const repeat = describeRecurrence(r.recurrence)
    return `${r.anchorKind === 'event_offset' ? '🗓️' : '⏰'} ${r.content} — ${fmtDateTime(r.fireAt, tz)}${repeat ? ` (${repeat})` : ''}${r.personal ? ' (just for you, here)' : ''}`
  })
  return `Coming up:\n${lines.join('\n')}`
}

// Introspection read-out: the discrete facts Baumy has picked up lately (docs/spec/telegram.md D9c).
// PURELY DETERMINISTIC (a direct read, no model). SECRET-SAFE by construction: is_secure rows are
// excluded, so a bulk "what do you know" can never dump a wifi/door/bank value — a specific value is
// only ever decrypted for a direct question via the reply path's disclosure discretion, never here.
// Excludes quarantined (forwarded/bot) content and system-trust reflect PROFILES (those are
// syntheses, not freshly-learned facts). Object may be a value or a linked entity (relationship edge).
export async function recentLearningsReport(db: Database, groupId: string, now: Date = clockNow()): Promise<string> {
  const since = new Date(now.getTime() - 30 * 86_400_000)
  const rows = rowsOf(
    await db.execute(sql`
      SELECT s.canonical_name AS subject,
             f.predicate AS predicate,
             COALESCE(f.object_value, o.canonical_name) AS object
      FROM baumy_facts f
      JOIN baumy_entities s ON f.subject_entity_id = s.id
      LEFT JOIN baumy_entities o ON f.object_entity_id = o.id
      WHERE f.group_id = ${groupId}
        AND ${liveFact('f', now)}
        AND f.is_secure = false
        AND f.trust_level <> 'quarantined'
        AND f.trust_level <> 'system'
        AND f.recorded_at >= ${since.toISOString()}
      ORDER BY f.recorded_at DESC
      LIMIT 12`),
  )
  const lines = rows
    .filter((r) => r.object != null && String(r.object).trim() !== '')
    .map((r) => `• ${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')} ${r.object as string}`)
  if (lines.length === 0) return "Haven't picked up anything new lately 😺"
  return `Recently learned:\n${lines.join('\n')}`
}
