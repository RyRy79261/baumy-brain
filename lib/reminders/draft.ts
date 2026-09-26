import { and, eq, gt, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { pendingActions } from '@/db/schema'
import { now } from '@/lib/core/clock'

// A reminder that is still waiting for its time (docs/spec/chat-understanding-v2.md §3, A2/A3).
//
// "remind us to call the landlord" with no time gets a clarifying question ("when should I remind
// you?"). The answer — "at 8pm", a reply to Baumy — carries the time but not the WHAT, so without a
// memory of the open request the follow-up extracted nothing and the reminder was never created.
// The open request is kept here: a `pending_actions` row of type REMINDER_DRAFT, scoped to the house,
// keyed on (chat, requester), short-lived, and consumed ONE-SHOT by the requester's next directed
// message in that chat (which either completes it or abandons it).
//
// It is NOT a confirm card: nothing is ever sent with its id, the confirm-tap handler refuses it
// (TAPPABLE_ACTIONS in lib/confirm/store.ts), and the console's pending-confirm list leaves it out.
// Completing it is the ordinary capture-tier reminder path (auto-commit, lane- and pause-gated).
export const REMINDER_DRAFT = 'reminder.draft'
const DRAFT_TTL_SEC = 6 * 3600

export interface ReminderDraftKey {
  /** The house scope (houseScopeForOrigin) — never the inbound chat. */
  groupId: string
  /** The chat the request was made in (the house group or the requester's DM). */
  chatId: string
  /** The authenticated requester (member id). */
  requestedBy: string
}

export async function saveReminderDraft(db: Database, key: ReminderDraftKey, content: string): Promise<void> {
  await db.insert(pendingActions).values({
    groupId: key.groupId,
    actionType: REMINDER_DRAFT,
    payload: { content, chatId: key.chatId },
    requestedBy: key.requestedBy,
    expiresAt: new Date(now().getTime() + DRAFT_TTL_SEC * 1000),
  })
}

// Atomically consume every open draft for (house, chat, requester) and return the newest one's
// content — one-shot, so a later unrelated message never re-reads an abandoned request.
export async function takeReminderDraft(db: Database, key: ReminderDraftKey): Promise<{ content: string } | null> {
  const rows = await db
    .update(pendingActions)
    .set({ status: 'consumed' })
    .where(
      and(
        eq(pendingActions.groupId, key.groupId),
        eq(pendingActions.actionType, REMINDER_DRAFT),
        eq(pendingActions.requestedBy, key.requestedBy),
        eq(pendingActions.status, 'pending'),
        gt(pendingActions.expiresAt, now()),
        sql`${pendingActions.payload}->>'chatId' = ${key.chatId}`,
      ),
    )
    .returning({ payload: pendingActions.payload, createdAt: pendingActions.createdAt })
  const newest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const content = (newest?.payload as { content?: unknown } | undefined)?.content
  return typeof content === 'string' && content.trim() ? { content } : null
}
