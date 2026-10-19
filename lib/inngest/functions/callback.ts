import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { resolvePendingAction, pendingForSomeoneElse, pendingTapType, TAP_ACTIONS } from '@/lib/confirm/store'
import { runTap, answerLogin, cancelled, type TapRun } from '@/lib/confirm/handlers'
import { answerCallback } from '@/lib/telegram/client'
import { loginCardChoices, parseLoginTap } from '@/lib/olympics/login-approval'
import { runShopTap, FAILED_TAP_TOAST } from '@/lib/lists/tap'

// Deterministic confirm handler (security Stage D / B4). A callback_query is a
// Telegram-authenticated button press; only an ACTIVE member/owner from.id may
// resolve a pending action. The press is the injection wall — group text can
// propose a privileged action but only a human tap executes it.
//
// Exported as a plain function (like runIngest) so the sandbox can drive a real TAP — the second half
// of the confirm wall — through the same code; the Inngest wrapper below only forwards its context.
export interface CallbackData {
  callbackId: string
  fromId: number
  chatId: string
  messageId?: number | null
  data: string
  /** A live-list item tap: tick / untick, read from the tapped button (null = unknown → flip). */
  want?: 'tick' | 'untick' | null
}
type CallbackStep = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }

export async function runCallback(event: { data: CallbackData }, step: CallbackStep) {
  const { callbackId, fromId, chatId, messageId, data, want } = event.data
  const db = createHttpDb()

  // Fail closed: only an active member/owner may confirm.
  const roster = await loadRoster(db)
  if (!roster.isMember(fromId)) {
    await answerCallback(callbackId, 'Not authorized.')
    return { ignored: 'not-member' }
  }

  // A tap on the live shopping list (`shop:…`, issue #25) — a list write, not a confirm: it auto-commits
  // like every list op (lib/lists/tap.ts). Routed BEFORE the confirm-card parse below.
  if (data.startsWith('shop:')) return runShopTap({ callbackId, fromId, chatId, messageId, data, want }, step, db)

  const [verb, id] = data.split(':')
  if ((verb !== 'c' && verb !== 'x' && verb !== 'l') || !id) {
    await answerCallback(callbackId)
    return { ignored: 'bad-data' }
  }

  const tapper = String(fromId)
  const run = (actionId: string): TapRun => ({ db, step, id: actionId, tapper, callbackId, card: messageId ? { chatId, messageId } : null })
  // A card that acts AS its asker (TAP_ACTIONS requesterOnly) is theirs alone to confirm or cancel.
  const notYours = async (actionId: string) => {
    const other = await pendingForSomeoneElse(db, actionId, tapper)
    if (other) await answerCallback(callbackId, 'Only the person who asked can confirm this one.')
    return other != null
  }
  const gone = async () => {
    await answerCallback(callbackId, 'This already expired or was handled.')
    return { ignored: 'not-pending' }
  }

  // A number on a Sign in with Baumy card (`l:<id>:<n>`): Olympics decides whether it is the one on the
  // screen. Only the member the card was sent to resolves it (requester-only).
  if (verb === 'l') {
    const t = parseLoginTap(data)
    const choices = t ? await step.run('login-card', () => loginCardChoices(db, t.actionId)) : null
    if (!t || (choices && !choices.includes(t.code))) {
      await answerCallback(callbackId)
      return { ignored: 'bad-data' }
    }
    const action = await step.run('login-resolve', () => resolvePendingAction(db, t.actionId, 'confirmed', tapper))
    if (!action && (await notYours(t.actionId))) return { ignored: 'not-requester' }
    if (!action || action.actionType !== 'olympics.login') return gone()
    return answerLogin(run(t.actionId), action.payload, 'approve_login', { requestId: action.payload.requestId, code: t.code })
  }

  if (verb === 'x') {
    const dropped = await step.run('cancel', () => resolvePendingAction(db, id, 'cancelled', tapper))
    if (!dropped && (await notYours(id))) return { ignored: 'not-requester' }
    return dropped ? runTap(run(id), dropped, 'cancel') : cancelled(run(id))
  }

  // A card with no Confirm button (a sign-in card): check the KIND before resolving, so crafted
  // `c:<id>` data can never spend it.
  const kind = await step.run('tap-kind-check', () => pendingTapType(db, id))
  if (kind && !TAP_ACTIONS[kind].confirmButton) {
    await answerCallback(callbackId)
    return { ignored: 'bad-data' }
  }

  // Resolve in its OWN step so the result is MEMOIZED: a retry after a downstream effect fails replays
  // the action here WITHOUT re-flipping the row, so the effect can safely re-run instead of being
  // silently lost to "already handled". Then the action's own handler (lib/confirm/handlers.ts).
  //
  // NOTE: reminders and shopping-list ops AUTO-COMMIT — deliberately exempt from this wall, so there is
  // no 'reminder.create' action (a 'reminder.draft' row is internal state — resolvePendingAction refuses
  // to flip it). The wall gates only the genuinely privileged actions in TAP_ACTIONS.
  const action = await step.run('resolve', () => resolvePendingAction(db, id, 'confirmed', tapper))
  if (!action && (await notYours(id))) return { ignored: 'not-requester' }
  if (!action) return gone()
  return runTap(run(id), action, 'confirm')
}

// When every retry has failed, still answer the callback query (best-effort — Telegram may already
// consider it too old), so a button never spins forever with no word. A live-list tap also toasts on its
// FIRST failure (lib/lists/tap.ts); this covers every callback.
export async function answerFailedCallback(callbackId: unknown): Promise<void> {
  if (typeof callbackId !== 'string' || !callbackId) return
  try {
    await answerCallback(callbackId, FAILED_TAP_TOAST)
  } catch (err) {
    console.warn('[baumy/callback] failure toast refused:', err instanceof Error ? err.message : err)
  }
}

export const handleCallbackQuery = inngest.createFunction(
  {
    id: 'handle-callback-query',
    retries: 2,
    onFailure: async ({ event }) => answerFailedCallback((event.data.event.data as { callbackId?: unknown }).callbackId),
  },
  { event: 'telegram/callback.received' },
  ({ event, step }) => runCallback(event, step as unknown as CallbackStep),
)
