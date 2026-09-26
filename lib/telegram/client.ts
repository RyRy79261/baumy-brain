import { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { record, isCapturing } from '@/lib/telegram/outbox'
import { now } from '@/lib/core/clock'
import { createHttpDb } from '@/db/client'
import { appendBaumySend, type BaumySend } from '@/lib/turn/window'
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
  _api = new Api(token)
  return _api
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

// Fixed-destination send (architecture D9): the caller resolves the destination
// (house config / stored deliver_chat_id / task group_id) — never the LLM.
export async function sendToHouse(
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
// member's authenticated from.id — is the injection wall for a privileged action.
export async function sendConfirmCard(
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

// DM reply — permitted ONLY for the auth/login response path to the originating
// member (architecture D9). Never for house content.
export async function sendDmLoginResponse(chatId: number | string, text: string): Promise<void> {
  if (record({ kind: 'dm', chatId: String(chatId), text }, now())) return
  await api().sendMessage(chatId, text, NO_PREVIEW)
}

// Ack a callback_query (dismisses the button spinner; optional toast text).
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  if (record({ kind: 'callback-answer', chatId: callbackId, text: text ?? null }, now())) return
  await api().answerCallbackQuery(callbackId, text ? { text } : {})
}

// Rewrite a card after a decision, dropping the keyboard (no reply_markup).
export async function editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
  if (record({ kind: 'edit', chatId, text, meta: String(messageId) }, now())) return
  await api().editMessageText(chatId, messageId, text, NO_PREVIEW)
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
