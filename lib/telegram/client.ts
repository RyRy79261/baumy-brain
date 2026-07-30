import { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { record, isCapturing } from '@/lib/telegram/outbox'
import { now } from '@/lib/core/clock'

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

// Fixed-destination send (architecture D9): the caller resolves the destination
// (house config / stored deliver_chat_id / task group_id) — never the LLM.
export async function sendToHouse(chatId: string, text: string, opts?: { silent?: boolean }): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no house chat id resolved (bot not added to a group yet?)')
  // Sandbox capture (lib/telegram/outbox.ts): enforced HERE, at the exit, so a sandbox cannot
  // reach the real house even if it is holding production config.
  if (record({ kind: 'message', chatId, text }, now())) return
  await api().sendMessage(chatId, text, { ...NO_PREVIEW, disable_notification: opts?.silent ?? false })
}

// Inline-keyboard confirm card (security B4). The tap — a callback_query from a
// member's authenticated from.id — is the injection wall for a privileged action.
export async function sendConfirmCard(chatId: string, text: string, actionId: string): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no chat id for confirm card')
  if (record({ kind: 'confirm-card', chatId, text, meta: actionId }, now())) return
  await api().sendMessage(chatId, text, {
    ...NO_PREVIEW,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `c:${actionId}` },
          { text: '✖️ Cancel', callback_data: `x:${actionId}` },
        ],
      ],
    },
  })
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

// Best-effort emoji reaction — Baumy's lightweight ack (👀 seen, 🧠 learned it, 👎 no
// idea) on a message instead of always sending a line. Pass null to CLEAR the reaction
// (swap the eyes out once it answers). Takes a plain string so functional signals like
// 🧠 (not in Telegram's default reaction set) can be attempted; if the group doesn't
// allow that emoji Telegram just 400s and this swallows it. Never breaks the pipeline.
export async function reactToMessage(chatId: string, messageId: number, emoji: string | null): Promise<void> {
  if (record({ kind: 'reaction', chatId, text: null, meta: emoji }, now())) return
  try {
    const reactions = emoji ? [{ type: 'emoji' as const, emoji: emoji as ReactionTypeEmoji['emoji'] }] : []
    await api().setMessageReaction(chatId, messageId, reactions)
  } catch {
    // reactions are cosmetic; a failure (perms, unsupported emoji) must not throw
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

// Baumy's own @username (from getMe), cached for the process — so directed-at-
// Baumy detection uses the bot's REAL name, never a hardcoded guess.
let cachedUsername: string | null = null
export async function getBotUsername(): Promise<string> {
  if (isCapturing()) return cachedUsername ?? 'baumy_bot' // sandbox: never call getMe, never poison the cache
  if (cachedUsername) return cachedUsername // only a NON-empty success is cached
  try {
    const u = ((await getMe()).username ?? '').toLowerCase()
    if (u) cachedUsername = u // cache on success only — never poison-cache '' from a transient getMe failure
    return u
  } catch {
    return '' // transient — leave the cache empty so the next call retries
  }
}
