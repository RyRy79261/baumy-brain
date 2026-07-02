import { and, desc, eq, gte, lte, ne } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { reminders, memoryItems } from '@/db/schema'

// Build a grounded house digest FROM DB records (never chat recall): upcoming
// reminders + recently-noted items. Deterministic — no LLM, so it's cheap, safe,
// and can never fabricate house state.
export async function buildDigest(db: Database, groupId: string, now: Date = new Date()): Promise<string> {
  const horizon = new Date(now.getTime() + 7 * 86_400_000)

  const upcoming = await db
    .select({ content: reminders.content, fireAt: reminders.fireAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.groupId, groupId),
        eq(reminders.status, 'scheduled'),
        gte(reminders.fireAt, now),
        lte(reminders.fireAt, horizon),
      ),
    )
    .orderBy(reminders.fireAt)
    .limit(10)

  const recent = await db
    .select({ content: memoryItems.content })
    .from(memoryItems)
    // Never surface secure values or quarantined (forwarded/bot) content unprompted.
    .where(
      and(
        eq(memoryItems.groupId, groupId),
        eq(memoryItems.isActive, true),
        eq(memoryItems.isSecure, false),
        ne(memoryItems.trustLevel, 'quarantined'),
      ),
    )
    .orderBy(desc(memoryItems.createdAt))
    .limit(8)

  const lines: string[] = ['🌳 House digest']
  if (upcoming.length > 0) {
    lines.push('', 'Coming up:')
    for (const u of upcoming) lines.push(`• ${u.content} — ${new Date(u.fireAt).toISOString().slice(0, 10)}`)
  }
  if (recent.length > 0) {
    lines.push('', 'Recently noted:')
    for (const r of recent) lines.push(`• ${r.content}`)
  }
  if (upcoming.length === 0 && recent.length === 0) lines.push('', 'Nothing on file this week.')
  return lines.join('\n')
}
