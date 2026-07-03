import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { type Database } from '@/db/client'
import { reminders, memoryItems } from '@/db/schema'
import { resolveModel } from '@/lib/ai/registry'
import { WEEKLY_REPORT_SYSTEM, GUEST_REPORT_SYSTEM } from '@/lib/ai/prompts'
import { retrieve } from '@/lib/memory/retrieve'
import { currentFactsForQuery } from '@/lib/memory/facts'
import { buildDigest } from '@/lib/reports/digest'
import { houseToday } from '@/lib/core/clock'

// On-demand house reports (owner feature): a slash command generates a formatted report
// from house memory. LLM-formatted (the data is free-form facts + notes) but grounded
// STRICTLY in what's stored — never invents — and degrades to a deterministic list on any
// model failure. Secure values + quarantined (forwarded/bot) content are excluded.
export type HouseReport = 'weekly' | 'guests'

// Detect a report slash command (/weekly, /guests) at the start of a message. Works in the
// house group OR a DM; deterministic, no false positives; strips a @botname suffix.
export function parseHouseReport(text: string | null | undefined): HouseReport | null {
  if (!text) return null
  const m = text.trim().match(/^\/(weekly|guests)(?:@\w+)?\b/i)
  return m ? (m[1].toLowerCase() as HouseReport) : null
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}
const fmtDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

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
          OR f.object_value ILIKE '%room%' OR f.object_value ILIKE '%cave%' OR f.object_value ILIKE '%bedroom%'
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
