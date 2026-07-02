import { and, eq, lte, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { reminders } from '@/db/schema'

export interface CreateReminderInput {
  groupId: string
  deliverChatId: string // resolved in code = house group (never LLM)
  content: string
  fireAt: Date
  anchorKind?: string
  createdBy: string | null
}

export async function createReminder(db: Database, input: CreateReminderInput): Promise<string> {
  const [r] = await db
    .insert(reminders)
    .values({
      groupId: input.groupId,
      deliverChatId: input.deliverChatId,
      content: input.content,
      anchorKind: input.anchorKind ?? 'absolute',
      fireAt: input.fireAt,
      status: 'scheduled',
      createdBy: input.createdBy,
    })
    .returning({ id: reminders.id })
  return r.id
}

// Atomic claim: only the FIRST caller flips scheduled→firing → exactly-once send.
// A single row-level UPDATE…WHERE status='scheduled' is atomic on any driver.
export async function claimReminder(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ status: 'firing' })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'scheduled')))
    .returning({ id: reminders.id })
  return rows.length > 0
}

export async function markSent(db: Database, id: string): Promise<void> {
  await db.update(reminders).set({ status: 'sent' }).where(eq(reminders.id, id))
}

export async function cancelReminder(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ status: 'cancelled' })
    .where(and(eq(reminders.id, id), sql`${reminders.status} in ('scheduled','firing')`))
    .returning({ id: reminders.id })
  return rows.length > 0
}

// Scheduled reminders due at/before `before` — for the arm cron + the sweeper.
export async function dueScheduled(db: Database, before: Date, limit = 100) {
  return db
    .select({
      id: reminders.id,
      fireAt: reminders.fireAt,
      deliverChatId: reminders.deliverChatId,
      content: reminders.content,
    })
    .from(reminders)
    .where(and(eq(reminders.status, 'scheduled'), lte(reminders.fireAt, before)))
    .limit(limit)
}
