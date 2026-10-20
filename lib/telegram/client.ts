import { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { record, isCapturing, sandboxChatMember } from '@/lib/telegram/outbox'
import { now } from '@/lib/core/clock'
import { createHttpDb } from '@/db/client'
import { appendBaumySend, replaceBaumySend, type BaumySend } from '@/lib/turn/window'
import type { PlannerEmoji } from '@/lib/turn/emoji'

// grammY typed Bot API client (transport layer). grammY owns the Bot API surface
// — methods, params, error handling, the bot's own identity — so we don't
// reinvent it. Sends stay deterministic and destination-fixed by the CALLER
// (architecture D9): the classifier/LLM can never choose a recipient.
let _api: Api | null = null
function api(): Api {
  if (_api) return _api
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('[baumy/telegram] TELEGRAM_BOT_TOKEN not set')
  const apiRoot = telegramApiRoot()
  _api = apiRoot ? new Api(token, { apiRoot }) : new Api(token)
  return _api
}

// The end-to-end stack (e2e/README.md) points the Bot API at a fake Telegram with TELEGRAM_API_ROOT.
// Refused in production, so a stray variable can never send the real bot's traffic somewhere else
// (the e2e deploy is a Vercel preview with a fake bot token, so real Telegram would reject it anyway).
export function telegramApiRoot(env: Record<string, string | undefined> = process.env): string | null {
  const root = env.TELEGRAM_API_ROOT?.trim()
  if (!root) return null
  if (env.VERCEL_ENV === 'production') {
    console.warn('[baumy/telegram] TELEGRAM_API_ROOT is ignored in production')
    return null
  }
  return root.replace(/\/+$/, '')
}

const NO_PREVIEW = { link_preview_options: { is_disabled: true } }

// Every Baumy send into the house group or a housemate's DM is appended to the 48h conversation
// window (docs/spec/chat-understanding-v2.md §5) HERE, at the exit — so no worded path (a reply, a
// list ack, a confirm card, a command's answer, a reminder, a heads-up) can forget to. The scope is
// resolved from the destination (house alias ids / an active member's DM); an unknown chat is not
// windowed. Best-effort AFTER the send: a window hiccup must never fail the send's step, whose retry
// would post the message twice. `windowText` replaces what is stored (still secret-redacted) when the
// sent text must not linger — a forget card naming the very thing to forget.
async function toWindow(s: BaumySend): Promise<void> {
  try {
    await appendBaumySend(createHttpDb(), s)
  } catch (err) {
    console.warn('[baumy/telegram] conversation-window append failed:', err instanceof Error ? err.message : err)
  }
}

// The transport exit for a worded message: sandbox capture, the Bot API call, the window append. The
// DESTINATION is decided by lib/telegram/send.ts (send / sendConfirm) — call that, not this, from
// feature code (fixed-destination invariant, architecture D9).
export async function postMessage(
  chatId: string,
  text: string,
  opts?: { silent?: boolean; threadId?: number; replyToMessageId?: number; windowText?: string },
): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no house chat id resolved (bot not added to a group yet?)')
  const windowed = (messageId: number) =>
    toWindow({ chatId, messageId, text: opts?.windowText ?? text, threadId: opts?.threadId ?? null, replyToMessageId: opts?.replyToMessageId ?? null })
  // Sandbox capture (lib/telegram/outbox.ts): enforced HERE, at the exit, so a sandbox cannot
  // reach the real house even if it is holding production config.
  const captured = record({ kind: 'message', chatId, text, ...(opts?.replyToMessageId != null ? { replyTo: opts.replyToMessageId } : {}) }, now())
  if (captured) return windowed(captured.messageId!)
  const sent = await api().sendMessage(chatId, text, {
    ...NO_PREVIEW,
    disable_notification: opts?.silent ?? false,
    // Forum-topic routing: land in a specific topic when one is set (reminders' "notification
    // channel"), else omit → the General topic. Only valid in a forum supergroup; Telegram ignores
    // it elsewhere. The id is code-resolved (config / echoed inbound thread), never LLM-chosen.
    ...(opts?.threadId != null ? { message_thread_id: opts.threadId } : {}),
    // A conversational answer is a Telegram REPLY to the message that triggered it (C11), so in a
    // busy chat it is clear what Baumy is answering. allow_sending_without_reply: if that message
    // was deleted meanwhile, still send rather than fail the step.
    ...(opts?.replyToMessageId != null ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } } : {}),
  })
  await windowed(sent.message_id)
}

// Inline-keyboard confirm card (security B4). The tap — a callback_query from a
// member's authenticated from.id — is the injection wall for a privileged action. Sent via send.ts sendConfirm.
export async function postConfirmCard(
  chatId: string,
  text: string,
  actionId: string,
  threadId?: number,
  replyToMessageId?: number,
  windowText?: string,
): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no chat id for confirm card')
  const windowed = (messageId: number) => toWindow({ chatId, messageId, text: windowText ?? text, threadId: threadId ?? null, replyToMessageId: replyToMessageId ?? null })
  const captured = record({ kind: 'confirm-card', chatId, text, meta: actionId, ...(replyToMessageId != null ? { replyTo: replyToMessageId } : {}) }, now())
  if (captured) return windowed(captured.messageId!)
  const sent = await api().sendMessage(chatId, text, {
    ...NO_PREVIEW,
    ...(replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    // Land in the forum topic the request came from (else the card jumps to General); omitted elsewhere.
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `c:${actionId}` },
          { text: '✖️ Cancel', callback_data: `x:${actionId}` },
        ],
      ],
    },
  })
  await windowed(sent.message_id)
}

// Baumy Olympics "Sign in with Baumy" card (docs/spec/olympics.md §Sign-in approval): one button per
// number (`l:<actionId>:<n>`, in the order Olympics gave) and Deny (`x:<actionId>`). The destination is
// the member's OWN DM, resolved by the caller from the roster for the Telegram id Olympics named — never
// the group, never text. Not windowed: it is not conversation, and the numbers must not linger.
export async function sendLoginApprovalCard(chatId: string, text: string, actionId: string, choices: number[]): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no chat id for the login approval card')
  if (record({ kind: 'confirm-card', chatId, text, meta: actionId }, now())) return
  await api().sendMessage(chatId, text, {
    ...NO_PREVIEW,
    reply_markup: {
      inline_keyboard: [
        choices.map((n) => ({ text: String(n), callback_data: `l:${actionId}:${n}` })),
        [{ text: '✖️ Deny', callback_data: `x:${actionId}` }],
      ],
    },
  })
}

// ── The live shopping list (issue #25, docs/spec/shopping-list.md §Live list) ─────────────────────────
// ONE message per house, posted once (by /list or /shoppinghere, or again when it was deleted), pinned
// silently, and EDITED in place on every change. The destination is code-resolved by the caller (the
// house's live send id + the stored topic), never text. PLAIN TEXT (no parse_mode): item names are only
// button labels, which Telegram never parses. NOT windowed: a status board, not conversation.
export type LiveKeyboard = { text: string; callback_data: string }[][]

export async function sendLiveList(chatId: string, text: string, keyboard: LiveKeyboard, threadId: number | null): Promise<number> {
  if (!chatId) throw new Error('[baumy/telegram] no house chat id for the shopping list')
  const captured = record({ kind: 'message', chatId, text, meta: 'live-list', keyboard, ...(threadId != null ? { threadId } : {}) }, now())
  if (captured) return captured.messageId!
  const sent = await api().sendMessage(chatId, text, {
    ...NO_PREVIEW,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    reply_markup: { inline_keyboard: keyboard },
  })
  return sent.message_id
}

/** What an edit of the live list did: `edited`; `unchanged` (Telegram's "message is not modified" — the
 *  list already reads this way, a success); `gone` (the message was deleted or can no longer be edited). */
export type LiveEditOutcome = 'edited' | 'unchanged' | 'gone'

const telegramText = (err: unknown): string => {
  const e = err as { description?: unknown; message?: unknown } | null
  return `${typeof e?.description === 'string' ? e.description : ''} ${typeof e?.message === 'string' ? e.message : ''}`
}
export const isNotModified = (err: unknown): boolean => /message is not modified/i.test(telegramText(err))
export const isMessageGone = (err: unknown): boolean =>
  /message to edit not found|MESSAGE_ID_INVALID|message can't be edited|message not found/i.test(telegramText(err))

// Edit the live list in place (text + keyboard). Any other Telegram error is thrown (the Inngest step
// retries it — a 429 included, with Telegram's retry_after; see lib/lists/board.ts).
export async function editLiveList(chatId: string, messageId: number, text: string, keyboard: LiveKeyboard): Promise<LiveEditOutcome> {
  if (record({ kind: 'edit', chatId, text, meta: String(messageId), keyboard }, now())) return 'edited'
  try {
    await api().editMessageText(chatId, messageId, text, { ...NO_PREVIEW, reply_markup: { inline_keyboard: keyboard } })
    return 'edited'
  } catch (err) {
    if (isNotModified(err)) return 'unchanged'
    if (isMessageGone(err)) return 'gone'
    throw err
  }
}

// Pin the live list SILENTLY (no notification to the house). Needs the "Pin messages" admin right; without
// it Telegram refuses — reported as false and LOGGED, never thrown, so the list still posts and updates.
export async function pinMessage(chatId: string, messageId: number): Promise<boolean> {
  if (record({ kind: 'pin', chatId, text: null, meta: String(messageId) }, now())) return true
  try {
    await api().pinChatMessage(chatId, messageId, { disable_notification: true })
    return true
  } catch (err) {
    console.warn(`[baumy/telegram] pin of ${chatId}/${messageId} refused:`, err instanceof Error ? err.message : err)
    return false
  }
}

// Unpin one message (the live list when it stops or moves). Best-effort like pinMessage.
export async function unpinMessage(chatId: string, messageId: number): Promise<boolean> {
  if (record({ kind: 'unpin', chatId, text: null, meta: String(messageId) }, now())) return true
  try {
    await api().unpinChatMessage(chatId, messageId)
    return true
  } catch (err) {
    console.warn(`[baumy/telegram] unpin of ${chatId}/${messageId} refused:`, err instanceof Error ? err.message : err)
    return false
  }
}

// Delete one of Baumy's own messages. Telegram refuses some deletes (a message older than 48h, a
// missing permission, already gone) — that is reported as false and LOGGED, never thrown, so the
// caller can fall back to an edit.
export async function deleteMessage(chatId: string, messageId: number): Promise<boolean> {
  if (record({ kind: 'delete', chatId, text: null, meta: String(messageId) }, now())) return true
  try {
    await api().deleteMessage(chatId, messageId)
    return true
  } catch (err) {
    console.warn(`[baumy/telegram] delete of ${chatId}/${messageId} refused:`, err instanceof Error ? err.message : err)
    return false
  }
}

// Rewrite an old live shopping list (the fallback when it cannot be deleted): plain text and NO keyboard
// (an edit without reply_markup drops the buttons). Not windowed, like the list itself. False (logged)
// when Telegram refuses the edit too.
export async function editShoppingBoard(chatId: string, messageId: number, text: string): Promise<boolean> {
  if (record({ kind: 'edit', chatId, text, meta: String(messageId) }, now())) return true
  try {
    await api().editMessageText(chatId, messageId, text, NO_PREVIEW)
    return true
  } catch (err) {
    console.warn(`[baumy/telegram] edit of ${chatId}/${messageId} refused:`, err instanceof Error ? err.message : err)
    return false
  }
}

// Ack a callback_query (dismisses the button spinner; optional toast text).
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  if (record({ kind: 'callback-answer', chatId: callbackId, text: text ?? null }, now())) return
  await api().answerCallbackQuery(callbackId, text ? { text } : {})
}

// Rewrite a card after a decision, dropping the keyboard (no reply_markup). The window row follows
// the edit (best-effort, after it — like toWindow), so the next turn reads what the card says NOW
// ("✅ Added…"), never the stale "confirm?" that made Baumy insist a done tap was still pending.
export async function editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
  if (!record({ kind: 'edit', chatId, text, meta: String(messageId) }, now())) await api().editMessageText(chatId, messageId, text, NO_PREVIEW)
  try {
    await replaceBaumySend(createHttpDb(), { chatId, messageId }, text)
  } catch (err) {
    console.warn('[baumy/telegram] conversation-window edit failed:', err instanceof Error ? err.message : err)
  }
}

// Best-effort emoji reaction — Baumy's lightweight ack (👀 seen, ✍ noted it, 👎 no idea) on a
// message instead of always sending a line. Pass null to CLEAR the reaction (swap the eyes out
// once it answers). Typed to PLANNER_EMOJI (lib/turn/emoji.ts), all Bot-API-valid reactions — the
// old free-string signature let an off-list brain emoji through, which Telegram 400'd on every call (K1).
// Cosmetic, so a failure (no permission, a group that restricts reactions) must never break the
// pipeline — but it is LOGGED, never silently swallowed: a silent catch is how K1 went unseen.
export async function reactToMessage(chatId: string, messageId: number, emoji: PlannerEmoji | null): Promise<void> {
  if (record({ kind: 'reaction', chatId, text: null, meta: emoji }, now())) return
  try {
    const reactions = emoji ? [{ type: 'emoji' as const, emoji: emoji as ReactionTypeEmoji['emoji'] }] : []
    await api().setMessageReaction(chatId, messageId, reactions)
  } catch (err) {
    console.warn(`[baumy/telegram] reaction ${emoji ?? '(clear)'} rejected on ${chatId}/${messageId}:`, err instanceof Error ? err.message : err)
  }
}

export async function getMe() {
  return api().getMe()
}

// User ids of the house group's admins (creator + administrators), excluding bots.
// Used ONLY as a dashboard HINT ("this member is a group admin — grant access?") —
// it NEVER auto-grants (that would delegate grant authority to the Telegram admin
// graph). Needs no bot-admin rights. Best-effort: empty set on any error.
export async function getGroupAdminIds(chatId: string): Promise<Set<string>> {
  if (!chatId || isCapturing()) return new Set() // no network in a sandbox; the hint degrades to empty
  try {
    const admins = await api().getChatAdministrators(chatId)
    return new Set(admins.filter((a) => !a.user.is_bot).map((a) => String(a.user.id)))
  } catch {
    return new Set()
  }
}

// A user's status in a chat (Bot API getChatMember): 'creator' | 'administrator' | 'member' |
// 'restricted' | 'left' | 'kicked', plus whether a restricted user is still a member. Used ONLY to let
// a housemate Baumy has never seen speak in the group DM it (K6, lib/identity/verify.ts) — Telegram's
// own membership graph, an authenticated answer about an authenticated user id, never message text.
// Needs no bot-admin rights for a group Baumy is in. Throws on a transport error (the caller fails
// closed). In a sandbox: the harness's membership directory, never the network.
export async function getChatMemberStatus(chatId: string, userId: number): Promise<{ status: string; isMember: boolean } | null> {
  if (isCapturing()) {
    const status = sandboxChatMember(chatId, userId)
    return status ? { status, isMember: status !== 'left' && status !== 'kicked' } : null
  }
  const m = await api().getChatMember(chatId, userId)
  return { status: m.status, isMember: m.status === 'restricted' ? (m as { is_member?: boolean }).is_member === true : m.status !== 'left' && m.status !== 'kicked' }
}

// Baumy's own identity (from getMe), cached for the process — so directed-at-Baumy detection uses
// the bot's REAL name and id, never a hardcoded guess. The sandbox never calls getMe (no network)
// and never poisons the cache; it answers with fixed stand-ins the harness also uses.
export const SANDBOX_BOT_USERNAME = 'baumy_bot'
export const SANDBOX_BOT_ID = 7_000_000_001

let cachedUsername: string | null = null
export async function getBotUsername(): Promise<string> {
  if (isCapturing()) return cachedUsername ?? SANDBOX_BOT_USERNAME
  if (cachedUsername) return cachedUsername // only a NON-empty success is cached
  try {
    const me = await getMe()
    const u = (me.username ?? '').toLowerCase()
    if (u) cachedUsername = u // cache on success only — never poison-cache '' from a transient getMe failure
    if (me.id) cachedBotId = me.id
    return u
  } catch {
    return '' // transient — leave the cache empty so the next call retries
  }
}

// Baumy's own numeric user id — what a reply's reply_to_message.from.id must equal for the reply
// to count as "to Baumy" (C8: is_bot alone made a reply to ANY bot directed). getMe, cached; if
// getMe is unreachable, the token's numeric prefix IS the bot id (Bot API token format
// "<bot_id>:<secret>"), so a transient Telegram hiccup never makes a real reply undirected.
let cachedBotId: number | null = null
export async function getBotId(): Promise<number | null> {
  if (isCapturing()) return SANDBOX_BOT_ID
  if (cachedBotId) return cachedBotId
  try {
    const me = await getMe()
    if (me.id) cachedBotId = me.id
    if (me.username && !cachedUsername) cachedUsername = me.username.toLowerCase()
    return me.id ?? null
  } catch {
    const prefix = Number((process.env.TELEGRAM_BOT_TOKEN ?? '').split(':')[0])
    return Number.isSafeInteger(prefix) && prefix > 0 ? prefix : null
  }
}
