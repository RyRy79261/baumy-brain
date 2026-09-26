import { and, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { reminders } from '@/db/schema'
import { now as clockNow } from '@/lib/core/clock'
import { nextOccurrence } from '@/lib/reminders/recurrence'

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
  // RRULE-lite, already validated + normalised (lib/reminders/recurrence.ts); null = a one-off.
  recurrence?: string | null
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
      recurrence: input.recurrence ?? null,
      // Explicit, not the column default: a Postgres defaultNow() is blind to a simulated clock (T13).
      createdAt: clockNow(),
    })
    .returning({ id: reminders.id })
  return r.id
}

// ── Recurring series (D3 / A6) ───────────────────────────────────────────────────────────────────
// A recurring reminder is a chain of one-off rows: each occurrence is delivered by the SAME proven
// claim → send → mark-sent machinery, and only then is the next occurrence created. Creating it is an
// INSERT … ON CONFLICT DO NOTHING on the unique previous_reminder_id, so a retry (or the repair sweep
// racing a delivery) can never schedule a series twice, and a crash between mark-sent and create-next
// is healed by repairRecurringSeries on the next digest. Nothing is ever armed twice either: the
// successor is armed by the daily arm cron / delivered by the digest like any other reminder.
export interface SeriesRow {
  id: string
  groupId: string
  deliverChatId: string
  content: string
  anchorKind: string
  fireAt: Date
  recurrence: string | null
  createdBy: string | null
}

/** Schedule the occurrence after `row` (strictly after `after`). Returns the new id, or null when
 *  the rule is invalid, or when a successor already exists (the exactly-once guard). */
export async function scheduleNextOccurrence(db: Database, row: SeriesRow, after: Date, tz: string): Promise<string | null> {
  if (!row.recurrence) return null
  const next = nextOccurrence(row.recurrence, new Date(row.fireAt), after, tz)
  if (!next) return null
  const inserted = await db
    .insert(reminders)
    .values({
      groupId: row.groupId,
      deliverChatId: row.deliverChatId,
      content: row.content,
      anchorKind: row.anchorKind,
      fireAt: next,
      status: 'scheduled',
      createdBy: row.createdBy,
      recurrence: row.recurrence,
      previousReminderId: row.id,
      createdAt: clockNow(),
    })
    .onConflictDoNothing({ target: reminders.previousReminderId })
    .returning({ id: reminders.id })
  return inserted[0]?.id ?? null
}

const seriesColumns = {
  id: reminders.id,
  groupId: reminders.groupId,
  deliverChatId: reminders.deliverChatId,
  content: reminders.content,
  anchorKind: reminders.anchorKind,
  fireAt: reminders.fireAt,
  recurrence: reminders.recurrence,
  createdBy: reminders.createdBy,
}

/** One reminder row in the series shape (the delivery paths load it after a send). */
export async function loadSeriesRow(db: Database, id: string): Promise<SeriesRow | null> {
  const [r] = await db.select(seriesColumns).from(reminders).where(eq(reminders.id, id)).limit(1)
  return r ?? null
}

// Heal a series whose "create next" never ran (the process died after mark-sent): every SENT recurring
// occurrence of the last few weeks without a successor gets one. Bounded, idempotent (the unique
// previous_reminder_id makes a concurrent delivery's insert and this one collapse into one row).
const REPAIR_LOOKBACK_DAYS = 35
export async function repairRecurringSeries(db: Database, now: Date, tz: string): Promise<number> {
  const since = new Date(now.getTime() - REPAIR_LOOKBACK_DAYS * 86_400_000)
  const res = await db.execute(sql`
    SELECT r.id FROM baumy_reminders r
    WHERE r.recurrence IS NOT NULL AND r.status = 'sent' AND r.fire_at >= ${since.toISOString()}
      AND NOT EXISTS (SELECT 1 FROM baumy_reminders n WHERE n.previous_reminder_id = r.id)`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  let created = 0
  for (const { id } of rows) {
    const row = await loadSeriesRow(db, String(id))
    if (row && (await scheduleNextOccurrence(db, row, now, tz))) created++
  }
  return created
}

// All fire times already scheduled/sent/cancelled for a dated fact — the event-surfacing scan's
// de-dupe key, so a stage is never nudged twice (and a cancelled/sent one is not recreated).
export async function remindersForEventFact(db: Database, eventFactId: string): Promise<{ fireAt: Date }[]> {
  return db.select({ fireAt: reminders.fireAt }).from(reminders).where(eq(reminders.eventFactId, eventFactId))
}

// Same, for every fact in one EVENT group. The scan anchors a heads-up to the group's earliest
// fact, but a sibling fact may have anchored an earlier run's reminder — checking the whole group
// is what stops "Ryan returns home" and "Ryan needs a lift" nudging the house twice about one
// arrival. Empty input → no query, no rows.
export async function remindersForEventFacts(db: Database, eventFactIds: string[]): Promise<{ fireAt: Date }[]> {
  if (eventFactIds.length === 0) return []
  return db.select({ fireAt: reminders.fireAt }).from(reminders).where(inArray(reminders.eventFactId, eventFactIds))
}

// Scheduled event-surfacing heads-ups whose anchoring fact is NO LONGER CURRENT (superseded or
// contradicted — "Iman's coming" → "Iman cancelled") — the integrity gap: surfacing only ever
// CREATES reminders, so a stale one would still deliver. The consolidation pass cancels these.
// Group-scoped; joins reminders → the fact it's anchored to; only pending (scheduled) ones.
// An anchor whose event is OVER (valid_to passed) is orphaned too — a heads-up about it is history.
export async function orphanedEventReminders(db: Database, groupId: string, now: Date = clockNow()): Promise<{ id: string }[]> {
  const res = await db.execute(sql`
    SELECT r.id
    FROM baumy_reminders r
    JOIN baumy_facts f ON r.event_fact_id = f.id
    WHERE r.group_id = ${groupId} AND r.anchor_kind = 'event_offset' AND r.status = 'scheduled'
      AND (f.is_current = false OR (f.valid_to IS NOT NULL AND f.valid_to <= ${now.toISOString()}))`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.map((r) => ({ id: String(r.id) }))
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
      recurrence: reminders.recurrence,
    })
    .from(reminders)
    .where(eq(reminders.groupId, groupId))
    .orderBy(desc(reminders.fireAt))
    .limit(limit)
}

// Scheduled reminders due at/before `before` — for the arm cron + the digest.
// `notBefore` is the STALENESS FLOOR: a reminder whose moment has long passed must never be
// delivered as if it were now. Without it, anything that sat un-delivered (a paused cron, a
// deploy gap) piled up as 'scheduled' forever and the next digest flushed the whole backlog —
// which is how a months-old reminder landed in the group this morning.
export async function dueScheduled(db: Database, before: Date, limit = 100, notBefore?: Date) {
  return db
    .select({
      id: reminders.id,
      fireAt: reminders.fireAt,
      deliverChatId: reminders.deliverChatId,
      content: reminders.content,
      anchorKind: reminders.anchorKind, // event_offset heads-ups render differently from ⏰ reminders
      eventFactId: reminders.eventFactId, // the event a heads-up is about — its line is written at delivery
      recurrence: reminders.recurrence,
    })
    .from(reminders)
    .where(
      and(
        eq(reminders.status, 'scheduled'),
        lte(reminders.fireAt, before),
        ...(notBefore ? [gte(reminders.fireAt, notBefore)] : []),
      ),
    )
    .orderBy(reminders.fireAt) // earliest-due first, so a >limit backlog drains in order
    .limit(limit)
}

// Retire reminders whose fire time is further past than the grace window — they are no longer
// news. Cancelled (not deleted) so the dashboard still shows what happened, and cancelled rows are
// gated out of every delivery path by claimReminder. Returns how many were retired so the digest
// can LOG the drop instead of silently swallowing it.
//
// A retired RECURRING occurrence does not end its series: the next occurrence is scheduled FIRST (the
// idempotent insert), then the stale one is retired — so a crash in between leaves a still-scheduled
// stale row that the next run retires, never a series with no future. Missing one bin night must not
// silently cancel every bin night after it.
export async function expireStaleScheduled(db: Database, olderThan: Date, opts: { now?: Date; tz?: string } = {}): Promise<number> {
  if (opts.tz) {
    const recurring = await db
      .select(seriesColumns)
      .from(reminders)
      .where(and(eq(reminders.status, 'scheduled'), lt(reminders.fireAt, olderThan), isNotNull(reminders.recurrence)))
    for (const r of recurring) await scheduleNextOccurrence(db, r, opts.now ?? clockNow(), opts.tz)
  }
  const rows = await db
    .update(reminders)
    .set({ status: 'cancelled' })
    .where(and(eq(reminders.status, 'scheduled'), lt(reminders.fireAt, olderThan)))
    .returning({ id: reminders.id })
  return rows.length
}
