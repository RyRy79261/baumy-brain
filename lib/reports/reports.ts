import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { reminders, memoryItems } from '@/db/schema'
import { resolveModel } from '@/lib/ai/registry'
import { WEEKLY_REPORT_SYSTEM, GUEST_REPORT_SYSTEM } from '@/lib/ai/prompts'
import { retrieve } from '@/lib/memory/retrieve'
import { currentFactsForQuery } from '@/lib/memory/facts'
import { buildDigest } from '@/lib/reports/digest'
import { houseToday } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'

// On-demand house reports (owner feature): a slash command generates a formatted report
// from house memory. LLM-formatted (the data is free-form facts + notes) but grounded
// STRICTLY in what's stored — never invents — and degrades to a deterministic list on any
// model failure. Secure values + quarantined (forwarded/bot) content are excluded.
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
const fmtDate = (d: Date | string) => DateTime.fromJSDate(new Date(d)).setZone(houseTz()).toISODate() ?? '' // house-local date, not UTC

// "What's been happening": recent notes + what's coming up (reminders), written as a short
// friendly digest. Falls back to the deterministic buildDigest on any model failure.
export async function weeklyReport(db: Database, groupId: string, now: Date = new Date()): Promise<string> {
  const horizon = new Date(now.getTime() + 14 * 86_400_000)
  const upcoming = await db
    .select({ content: reminders.content, fireAt: reminders.fireAt })
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'scheduled'), gte(reminders.fireAt, now), lte(reminders.fireAt, horizon)))
    .orderBy(reminders.fireAt)
    .limit(12)
  const recent = await db
    .select({ content: memoryItems.content })
    .from(memoryItems)
    .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.isActive, true), eq(memoryItems.isSecure, false), ne(memoryItems.trustLevel, 'quarantined')))
    .orderBy(desc(memoryItems.createdAt))
    .limit(20)

  if (!upcoming.length && !recent.length) return 'Pretty quiet lately — nothing much on file 😺'

  const grounding = [
    ...recent.map((r) => `- noted: ${r.content}`),
    ...upcoming.map((u) => `- reminder (${fmtDate(u.fireAt)}): ${u.content}`),
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
    console.error('weeklyReport: model failed — deterministic digest:', err)
    return buildDigest(db, groupId, now)
  }
}

// "Who's in which room over the next month": guest/room/stay facts + notes, assembled into
// a room-by-room / person-by-person report. Falls back to the raw list on model failure.
export async function guestReport(db: Database, groupId: string, now: Date = new Date()): Promise<string> {
  // Directly pull facts about staying / rooms / arrivals (the structured half).
  const stayFacts = rowsOf(
    await db.execute(sql`
      SELECT e.canonical_name AS subject, f.predicate AS predicate, f.object_value AS "objectValue"
      FROM baumy_facts f JOIN baumy_entities e ON f.subject_entity_id = e.id
      WHERE f.group_id = ${groupId} AND f.is_current = true AND f.is_secure = false AND f.object_value IS NOT NULL
        AND (
          f.predicate ILIKE '%stay%' OR f.predicate ILIKE '%sleep%' OR f.predicate ILIKE '%room%'
          OR f.predicate ILIKE '%arriv%' OR f.predicate ILIKE '%visit%' OR f.predicate ILIKE '%guest%'
          OR f.object_value ~* '\y(room|bedroom|cave|lounge)\y'  -- whole words: not "mushroom"/"concave"
        )
      LIMIT 30`),
  )
  // Semantic/lexical half — raw notes about guests/rooms/arrivals.
  let mems: Awaited<ReturnType<typeof retrieve>> = []
  try {
    mems = await retrieve('guests staying visiting bedroom room cave arriving this month next few weeks', { groupId, k: 20, floor: 0.05 }, { db })
  } catch {
    /* best-effort */
  }
  const facts = await currentFactsForQuery(db, groupId, 'guest staying room bedroom cave arriving visiting who is in', 20)

  const lines = [
    ...stayFacts.map((r) => `- ${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}: ${(r.objectValue as string) ?? ''}`),
    ...facts.filter((f) => !f.isSecure).map((f) => `- ${f.content}`),
    ...mems.filter((m) => !m.isSecure).map((m) => `- ${m.content}`),
  ]
  const grounding = [...new Set(lines)].join('\n')
  if (!grounding) return 'No guests on the books that I know of — the house is all yours 😺'

  try {
    const { text } = await generateText({
      model: resolveModel('assess'),
      system: GUEST_REPORT_SYSTEM,
      prompt: `TODAY: ${houseToday(now)}\n\nHOUSE MEMORY (your ONLY source):\n${grounding}`,
    })
    return text.trim() || `Here's what I've got on guests:\n${grounding}`
  } catch (err) {
    console.error('guestReport: model failed — raw list:', err)
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
export async function upcomingRemindersReport(db: Database, groupId: string, tz: string, now: Date = new Date()): Promise<string> {
  const rows = await db
    .select({ content: reminders.content, fireAt: reminders.fireAt, anchorKind: reminders.anchorKind })
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'scheduled'), gte(reminders.fireAt, now)))
    .orderBy(reminders.fireAt)
    .limit(25)
  if (rows.length === 0) return 'Nothing on the calendar right now — all clear 😺'
  const lines = rows.map((r) => `${r.anchorKind === 'event_offset' ? '🗓️' : '⏰'} ${r.content} — ${fmtDateTime(r.fireAt, tz)}`)
  return `Coming up:\n${lines.join('\n')}`
}

// Introspection read-out: the discrete facts Baumy has picked up lately (docs/spec/telegram.md D9c).
// PURELY DETERMINISTIC (a direct read, no model). SECRET-SAFE by construction: is_secure rows are
// excluded, so a bulk "what do you know" can never dump a wifi/door/bank value — a specific value is
// only ever decrypted for a direct question via the reply path's disclosure discretion, never here.
// Excludes quarantined (forwarded/bot) content and system-trust reflect PROFILES (those are
// syntheses, not freshly-learned facts). Object may be a value or a linked entity (relationship edge).
export async function recentLearningsReport(db: Database, groupId: string, now: Date = new Date()): Promise<string> {
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
        AND f.is_current = true
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
