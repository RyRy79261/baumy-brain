import { and, eq, gt, inArray, ne, or } from 'drizzle-orm'
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
export const TAPPABLE_ACTIONS = ['memory.forget', 'github.issue', 'reminder.cancel', 'olympics.action'] as const

// Actions that run AS the person who asked (a Baumy Olympics write goes out with their Telegram id as
// X-Baumy-Actor — docs/spec/olympics.md): only THAT person's tap may confirm or cancel one. Any
// member may resolve the others (they act on the house, not as someone).
export const REQUESTER_ONLY_ACTIONS = ['olympics.action'] as const

// Atomic single-use resolve: flips pending → confirmed|cancelled ONLY if still
// pending AND unexpired, returning the action to the first caller (exactly-once).
// `tapper` = the authenticated from.id of the tap; a requester-only action resolves only for them.
export async function resolvePendingAction(db: Database, id: string, to: 'confirmed' | 'cancelled', tapper?: string): Promise<ResolvedAction | null> {
  const rows = await db
    .update(pendingActions)
    .set({ status: to })
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.status, 'pending'),
        gt(pendingActions.expiresAt, now()),
        inArray(pendingActions.actionType, [...TAPPABLE_ACTIONS]),
        tapper
          ? or(inArray(pendingActions.actionType, [...TAPPABLE_ACTIONS].filter((t) => !isRequesterOnly(t))), eq(pendingActions.requestedBy, tapper))
          : and(...REQUESTER_ONLY_ACTIONS.map((t) => ne(pendingActions.actionType, t))),
      ),
    )
    .returning({ actionType: pendingActions.actionType, payload: pendingActions.payload, groupId: pendingActions.groupId })
  const r = rows[0]
  return r ? { actionType: r.actionType, payload: r.payload as Record<string, unknown>, groupId: r.groupId } : null
}

const isRequesterOnly = (t: string) => (REQUESTER_ONLY_ACTIONS as readonly string[]).includes(t)

/** Why a tap resolved nothing, when it is because someone else asked for it: the pending
 *  requester-only action, or null (expired / handled / unknown — the ordinary answer). */
export async function pendingForSomeoneElse(db: Database, id: string, tapper: string): Promise<{ actionType: string } | null> {
  const [r] = await db
    .select({ actionType: pendingActions.actionType, requestedBy: pendingActions.requestedBy })
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending'), gt(pendingActions.expiresAt, now())))
  if (!r || !isRequesterOnly(r.actionType) || r.requestedBy === tapper) return null
  return { actionType: r.actionType }
}

/** Put a confirmed requester-only action back to pending (unexpired only), so its asker can tap again
 *  after Olympics did not answer. The retry resends the SAME stored Idempotency-Key. */
export async function reopenPendingAction(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(pendingActions)
    .set({ status: 'pending' })
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.status, 'confirmed'),
        gt(pendingActions.expiresAt, now()),
        inArray(pendingActions.actionType, [...REQUESTER_ONLY_ACTIONS]),
      ),
    )
    .returning({ id: pendingActions.id })
  return rows.length > 0
}
