import { and, asc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { reminders, pendingActions } from '@/db/schema'
import { orphanedEventReminders } from '@/lib/reminders/store'
import { upcomingDatedFacts, recentUndatedFacts } from '@/lib/memory/facts'

// "What is Baumy about to do?" — the console's pending view (docs/spec/sandbox-console.md).
//
// Every query takes `now` explicitly rather than reading the wall clock, for two reasons: it is
// the same discipline the delivery cores already follow (deliverDueReminders(db, now) et al), and
// it means Phase 2's time machine can render this exact view at a SIMULATED timestamp without
// touching a line of it.
//
// Temporal has to infer pending timers by folding its event log; ours are rows with a
// (status, fire_at) index, so this is a handful of cheap indexed reads.

// Mirrors STALE_AFTER_HOURS in lib/inngest/functions/reminders.ts — the delivery grace window.
// Duplicated as a read-only lens rather than imported, so the console can show the boundary
// without pulling the Inngest client into a page render.
const STALE_AFTER_HOURS = 24
const staleBefore = (now: Date): Date => new Date(now.getTime() - STALE_AFTER_HOURS * 3_600_000)

export interface PendingReminder {
  id: string
  content: string
  fireAt: Date
  anchorKind: string
  status: string
  eventFactId: string | null
}

const reminderCols = {
  id: reminders.id,
  content: reminders.content,
  fireAt: reminders.fireAt,
  anchorKind: reminders.anchorKind,
  status: reminders.status,
  eventFactId: reminders.eventFactId,
}

// DUE: scheduled, past its moment, and still inside the grace window — this is exactly the set the
// next digest run will deliver.
export async function dueNow(db: Database, groupId: string, now: Date, limit = 100): Promise<PendingReminder[]> {
  return db
    .select(reminderCols)
    .from(reminders)
    .where(
      and(
        eq(reminders.groupId, groupId),
        eq(reminders.status, 'scheduled'),
        lte(reminders.fireAt, now),
        gte(reminders.fireAt, staleBefore(now)),
      ),
    )
    .orderBy(asc(reminders.fireAt))
    .limit(limit)
}

// UPCOMING: scheduled and still in the future, soonest first.
export async function upcoming(db: Database, groupId: string, now: Date, limit = 100): Promise<PendingReminder[]> {
  return db
    .select(reminderCols)
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'scheduled'), gt(reminders.fireAt, now)))
    .orderBy(asc(reminders.fireAt))
    .limit(limit)
}

// STALE: past the grace window. These will be CANCELLED, not delivered, by the next digest run —
// surfacing them is the difference between "the house got months-old news" and "I saw the backlog
// on the dashboard first".
export async function staleBacklog(db: Database, groupId: string, now: Date, limit = 100): Promise<PendingReminder[]> {
  return db
    .select(reminderCols)
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'scheduled'), lt(reminders.fireAt, staleBefore(now))))
    .orderBy(asc(reminders.fireAt))
    .limit(limit)
}

// STUCK: claimed for sending but never marked sent — a process died mid-send. reapStaleFiring
// rescues these, so a row lingering here means the reaper has not run yet.
export async function stuckFiring(db: Database, groupId: string, limit = 50): Promise<PendingReminder[]> {
  return db
    .select(reminderCols)
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.status, 'firing')))
    .orderBy(asc(reminders.fireAt))
    .limit(limit)
}

export interface PendingConfirm {
  id: string
  actionType: string
  requestedBy: string | null
  expiresAt: Date
  createdAt: Date
  expired: boolean
}

// Confirm cards awaiting a tap. NOTE: `payload` is deliberately NOT selected — it is provenance
// (the exact proposal a human reviews) and, for a memory.forget card, it carries the values being
// scrubbed. The console shows that a decision is pending and what KIND it is, never its contents.
export async function pendingConfirms(db: Database, groupId: string, now: Date, limit = 50): Promise<PendingConfirm[]> {
  const rows = await db
    .select({
      id: pendingActions.id,
      actionType: pendingActions.actionType,
      requestedBy: pendingActions.requestedBy,
      expiresAt: pendingActions.expiresAt,
      createdAt: pendingActions.createdAt,
    })
    .from(pendingActions)
    .where(and(eq(pendingActions.groupId, groupId), eq(pendingActions.status, 'pending')))
    .orderBy(asc(pendingActions.expiresAt))
    .limit(limit)
  // Expiry is evaluated against the passed `now`, not the DB clock — so this stays honest under a
  // simulated timestamp. resolvePendingAction applies the real gate at tap time.
  return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() <= now.getTime() }))
}

// Unconsumed dashboard login links. COUNT ONLY — token_hash is a credential and is classified
// `secret` in the column policy, so it is never selected here or anywhere else.
export async function liveLoginLinks(db: Database, now: Date): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM baumy_dashboard_login_tokens
    WHERE consumed_at IS NULL AND expires_at > ${now.toISOString()}`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return Number(rows[0]?.n ?? 0)
}

export interface PendingWork {
  now: Date
  due: PendingReminder[]
  upcoming: PendingReminder[]
  stale: PendingReminder[]
  stuck: PendingReminder[]
  // Scheduled heads-ups whose anchoring fact is no longer current — the consolidation sweep
  // cancels these; seeing them means an event changed and the nudge has not caught up.
  orphaned: { id: string }[]
  // Dated facts inside the surfacing horizon: the events a nudge COULD be written for.
  horizon: Awaited<ReturnType<typeof upcomingDatedFacts>>
  // Recent facts with no resolved date — the consolidation catch-up candidates.
  undated: Awaited<ReturnType<typeof recentUndatedFacts>>
  confirms: PendingConfirm[]
  loginLinks: number
}

const HORIZON_DAYS = 8 // matches the surfacing scan
const LOOKBACK_DAYS = 14 // matches the consolidation decay bound

// One call for the whole pending view. Sequential rather than Promise.all: neon-http opens a
// connection per statement and this is a once-per-page-load read, so the parallelism would buy
// nothing and complicate error attribution.
export async function pendingWork(db: Database, groupId: string, now: Date): Promise<PendingWork> {
  const horizonTo = new Date(now.getTime() + HORIZON_DAYS * 86_400_000)
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)
  return {
    now,
    due: await dueNow(db, groupId, now),
    upcoming: await upcoming(db, groupId, now),
    stale: await staleBacklog(db, groupId, now),
    stuck: await stuckFiring(db, groupId),
    orphaned: await orphanedEventReminders(db, groupId),
    horizon: await upcomingDatedFacts(db, groupId, now, horizonTo),
    undated: await recentUndatedFacts(db, groupId, since),
    confirms: await pendingConfirms(db, groupId, now),
    loginLinks: await liveLoginLinks(db, now),
  }
}
