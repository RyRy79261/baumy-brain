import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { reminders } from '@/db/schema'

export interface CreateReminderInput {
  groupId: string
  deliverChatId: string // resolved in code = house group (never LLM)
  content: string
  fireAt: Date
  anchorKind?: string
  createdBy: string | null
  // The dated fact this reminder is anchored to (event-surfacing heads-ups); null for an
  // explicit "remind me" reminder. Lets the scan de-dupe stages per event (docs/spec/event-surfacing.md).
  eventFactId?: string | null
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
      eventFactId: input.eventFactId ?? null,
    })
    .returning({ id: reminders.id })
  return r.id
}

// All fire times already scheduled/sent/cancelled for a dated fact — the event-surfacing scan's
// de-dupe key, so a stage is never nudged twice (and a cancelled/sent one is not recreated).
export async function remindersForEventFact(db: Database, eventFactId: string): Promise<{ fireAt: Date }[]> {
  return db.select({ fireAt: reminders.fireAt }).from(reminders).where(eq(reminders.eventFactId, eventFactId))
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

// Return a claimed row to 'scheduled' when its send FAILS, so a retry/sweeper
// re-attempts it — closes the "fires zero times" hole (audit #10) without
// re-sending a delivered reminder (markSent only runs on success).
export async function releaseReminder(db: Database, id: string): Promise<void> {
  await db.update(reminders).set({ status: 'scheduled' }).where(and(eq(reminders.id, id), eq(reminders.status, 'firing')))
}

// Backstop: reset reminders orphaned in 'firing' (process died mid-send) whose
// fire time is well past, so the sweeper re-delivers them. The margin makes a
// double-send against an in-flight delivery negligible.
export async function reapStaleFiring(db: Database, olderThan: Date): Promise<number> {
  const rows = await db
    .update(reminders)
    .set({ status: 'scheduled' })
    .where(and(eq(reminders.status, 'firing'), lte(reminders.fireAt, olderThan)))
    .returning({ id: reminders.id })
  return rows.length
}

export async function cancelReminder(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ status: 'cancelled' })
    .where(and(eq(reminders.id, id), sql`${reminders.status} in ('scheduled','firing')`))
    .returning({ id: reminders.id })
  return rows.length > 0
}

// All reminders for the house group (dashboard view), most-recent fire time first.
export async function listReminders(db: Database, groupId: string, limit = 100) {
  return db
    .select({
      id: reminders.id,
      content: reminders.content,
      fireAt: reminders.fireAt,
      status: reminders.status,
      createdBy: reminders.createdBy,
    })
    .from(reminders)
    .where(eq(reminders.groupId, groupId))
    .orderBy(desc(reminders.fireAt))
    .limit(limit)
}

// Scheduled reminders due at/before `before` — for the arm cron + the sweeper.
export async function dueScheduled(db: Database, before: Date, limit = 100) {
  return db
    .select({
      id: reminders.id,
      fireAt: reminders.fireAt,
      deliverChatId: reminders.deliverChatId,
      content: reminders.content,
      anchorKind: reminders.anchorKind, // event_offset heads-ups render differently from ⏰ reminders
    })
    .from(reminders)
    .where(and(eq(reminders.status, 'scheduled'), lte(reminders.fireAt, before)))
    .orderBy(reminders.fireAt) // earliest-due first, so a >limit backlog drains in order
    .limit(limit)
}
