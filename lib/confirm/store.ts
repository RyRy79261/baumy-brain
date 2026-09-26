import { and, eq, gt, inArray } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { pendingActions } from '@/db/schema'
import { now } from '@/lib/core/clock'

export interface PendingActionInput {
  groupId: string
  actionType: string
  payload: Record<string, unknown>
  requestedBy: string | null
  ttlSec?: number
}

export async function createPendingAction(db: Database, input: PendingActionInput): Promise<string> {
  const [row] = await db
    .insert(pendingActions)
    .values({
      groupId: input.groupId,
      actionType: input.actionType,
      payload: input.payload,
      requestedBy: input.requestedBy,
      // The clock seam, not the wall clock: under a simulated now (sandbox / console) a card
      // must expire relative to the instant it was proposed, or its TTL is judged against a
      // different timeline than every other read of it.
      expiresAt: new Date(now().getTime() + (input.ttlSec ?? 3600) * 1000),
    })
    .returning({ id: pendingActions.id })
  return row.id
}

export interface ResolvedAction {
  actionType: string
  payload: Record<string, unknown>
  /** The house SCOPE the action was proposed against (stored at propose time). A confirmed
   *  action executes against THIS — never the chat the button was tapped in (A1): a card sent to
   *  a member's DM, or tapped in a migrated -100… supergroup, still targets the house scope. */
  groupId: string
}

// The action types a confirm TAP may resolve — the ones a card with buttons is ever sent for. Other
// rows in this table (a reminder draft waiting for its time, lib/reminders/draft.ts) are internal
// state: a callback naming one is refused rather than flipping it.
export const TAPPABLE_ACTIONS = ['memory.forget', 'github.issue', 'reminder.cancel'] as const

// Atomic single-use resolve: flips pending → confirmed|cancelled ONLY if still
// pending AND unexpired, returning the action to the first caller (exactly-once).
export async function resolvePendingAction(db: Database, id: string, to: 'confirmed' | 'cancelled'): Promise<ResolvedAction | null> {
  const rows = await db
    .update(pendingActions)
    .set({ status: to })
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.status, 'pending'),
        gt(pendingActions.expiresAt, now()),
        inArray(pendingActions.actionType, [...TAPPABLE_ACTIONS]),
      ),
    )
    .returning({ actionType: pendingActions.actionType, payload: pendingActions.payload, groupId: pendingActions.groupId })
  const r = rows[0]
  return r ? { actionType: r.actionType, payload: r.payload as Record<string, unknown>, groupId: r.groupId } : null
}
