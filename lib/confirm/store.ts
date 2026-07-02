import { and, eq, gt } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { pendingActions } from '@/db/schema'

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
      expiresAt: new Date(Date.now() + (input.ttlSec ?? 3600) * 1000),
    })
    .returning({ id: pendingActions.id })
  return row.id
}

// Atomic single-use resolve: flips pending → confirmed|cancelled ONLY if still
// pending AND unexpired, returning the action to the first caller (exactly-once).
export async function resolvePendingAction(
  db: Database,
  id: string,
  to: 'confirmed' | 'cancelled',
): Promise<{ actionType: string; payload: Record<string, unknown> } | null> {
  const rows = await db
    .update(pendingActions)
    .set({ status: to })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending'), gt(pendingActions.expiresAt, new Date())))
    .returning({ actionType: pendingActions.actionType, payload: pendingActions.payload })
  const r = rows[0]
  return r ? { actionType: r.actionType, payload: r.payload as Record<string, unknown> } : null
}
