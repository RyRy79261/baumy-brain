import { and, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { pendingActions } from '@/db/schema'
import { now } from '@/lib/core/clock'
import type { ForgetMode, AliasHit } from '@/lib/memory/forget'
import type { OlympicsPending } from '@/lib/olympics/intents'
import type { LoginPending } from '@/lib/olympics/login-approval'

// ── The confirm-tap wall's action types (security B4) ─────────────────────────────────────────────────
// Every action a card with buttons is ever sent for, with the payload stored at PROPOSE time and read
// back at TAP time. One map, so a payload is typed on both sides (no hand casts), and the handler table
// (lib/confirm/handlers.ts) must cover every type — TypeScript refuses a type without a handler.
export interface TapPayloads {
  /** "forget X" — the exact fact / note ids and values resolved at propose time (lib/memory/forget.ts). */
  'memory.forget': { mode: ForgetMode; factIds: string[]; scrubValues: string[]; noteIds: string[]; aliasHits: AliasHit[]; summary: string }
  /** "stop the bins reminder" — the reminder ids the asker could see, with their code-rendered labels. */
  'reminder.cancel': { reminderIds: string[]; labels: string[]; target: string }
  /** A Baumy Olympics write, run AS the asker with the Idempotency-Key minted here. */
  'olympics.action': OlympicsPending
  /** A Sign in with Baumy approval card, answered AS the member it was sent to. */
  'olympics.login': LoginPending
  /** /bug or /feature — the enriched issue to file. */
  'github.issue': { title: string; body: string; labels: string[]; type: string }
}
export type TapType = keyof TapPayloads

// requesterOnly: the action runs AS the person who asked (an Olympics write goes out with their Telegram
// id as X-Baumy-Actor; a sign-in card answers for its member) — only THAT person's tap resolves it. Any
// member may resolve the others (they act on the house, not as someone).
// confirmButton: false for a card with no Confirm button (a sign-in card is answered by a number or
// Deny) — crafted `c:<id>` data is refused before anything is resolved.
export const TAP_ACTIONS: Record<TapType, { requesterOnly: boolean; confirmButton: boolean }> = {
  'memory.forget': { requesterOnly: false, confirmButton: true },
  'reminder.cancel': { requesterOnly: false, confirmButton: true },
  'github.issue': { requesterOnly: false, confirmButton: true },
  'olympics.action': { requesterOnly: true, confirmButton: true },
  'olympics.login': { requesterOnly: true, confirmButton: false },
}

// The action types a confirm TAP may resolve. Other rows in this table (a reminder draft waiting for its
// time, lib/reminders/draft.ts) are internal state: a callback naming one is refused rather than flipped.
export const TAPPABLE_ACTIONS = Object.keys(TAP_ACTIONS) as TapType[]
export const REQUESTER_ONLY_ACTIONS = TAPPABLE_ACTIONS.filter((t) => TAP_ACTIONS[t].requesterOnly)
export const isTapType = (t: string): t is TapType => Object.hasOwn(TAP_ACTIONS, t)

export interface PendingActionInput<T extends TapType> {
  /** The house SCOPE the action targets (never the chat the card is sent to). */
  groupId: string
  actionType: T
  payload: TapPayloads[T]
  requestedBy: string | null
  ttlSec?: number
}

export async function createPendingAction<T extends TapType>(db: Database, input: PendingActionInput<T>): Promise<string> {
  const [row] = await db
    .insert(pendingActions)
    .values({
      groupId: input.groupId,
      actionType: input.actionType,
      payload: input.payload as unknown as Record<string, unknown>,
      requestedBy: input.requestedBy,
      // The clock seam, not the wall clock: under a simulated now (sandbox / console) a card
      // must expire relative to the instant it was proposed, or its TTL is judged against a
      // different timeline than every other read of it.
      expiresAt: new Date(now().getTime() + (input.ttlSec ?? 3600) * 1000),
    })
    .returning({ id: pendingActions.id })
  return row.id
}

/** A resolved action, discriminated by type: `payload` is that type's stored payload. `groupId` is the
 *  house SCOPE it was proposed against — a confirmed action executes against THIS, never the chat the
 *  button was tapped in (A1): a card sent to a member's DM, or tapped in a migrated -100… supergroup,
 *  still targets the house scope. */
export type ResolvedAction = { [K in TapType]: { actionType: K; payload: TapPayloads[K]; groupId: string } }[TapType]

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
  // The WHERE clause only flips a TAPPABLE type, so the stored type is one of ours; the payload is what
  // createPendingAction stored for that type.
  return r && isTapType(r.actionType) ? ({ actionType: r.actionType, payload: r.payload, groupId: r.groupId } as ResolvedAction) : null
}

const isRequesterOnly = (t: string) => isTapType(t) && TAP_ACTIONS[t].requesterOnly

/** The type of a still-pending, unexpired tappable action (read-only; null otherwise). Lets a tap be
 *  refused by its KIND before anything is resolved (a crafted Confirm on a card without one). */
export async function pendingTapType(db: Database, id: string): Promise<TapType | null> {
  const [r] = await db
    .select({ actionType: pendingActions.actionType })
    .from(pendingActions)
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending'), gt(pendingActions.expiresAt, now())))
  return r && isTapType(r.actionType) ? r.actionType : null
}

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
