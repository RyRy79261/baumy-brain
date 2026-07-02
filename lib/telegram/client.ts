import { Api } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'

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
  await api().sendMessage(chatId, text, { ...NO_PREVIEW, disable_notification: opts?.silent ?? false })
}

// Inline-keyboard confirm card (security B4). The tap — a callback_query from a
// member's authenticated from.id — is the injection wall for a privileged action.
export async function sendConfirmCard(chatId: string, text: string, actionId: string): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no chat id for confirm card')
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
  await api().sendMessage(chatId, text, NO_PREVIEW)
}

// Ack a callback_query (dismisses the button spinner; optional toast text).
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await api().answerCallbackQuery(callbackId, text ? { text } : {})
}

// Rewrite a card after a decision, dropping the keyboard (no reply_markup).
export async function editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
  await api().editMessageText(chatId, messageId, text, NO_PREVIEW)
}

// Best-effort emoji reaction — Baumy's lightweight ack (👀 seen, 👍 noted) on a
// message instead of always sending a line. Pass null to CLEAR the reaction (swap
// the eyes out once it answers). Never breaks the pipeline on failure.
export async function reactToMessage(
  chatId: string,
  messageId: number,
  emoji: ReactionTypeEmoji['emoji'] | null,
): Promise<void> {
  try {
    await api().setMessageReaction(chatId, messageId, emoji ? [{ type: 'emoji', emoji }] : [])
  } catch {
    // reactions are cosmetic; a failure (perms, unsupported emoji) must not throw
  }
}

export async function getMe() {
  return api().getMe()
}

// Baumy's own @username (from getMe), cached for the process — so directed-at-
// Baumy detection uses the bot's REAL name, never a hardcoded guess.
let cachedUsername: string | null = null
export async function getBotUsername(): Promise<string> {
  if (cachedUsername !== null) return cachedUsername
  try {
    cachedUsername = ((await getMe()).username ?? '').toLowerCase()
  } catch {
    cachedUsername = ''
  }
  return cachedUsername
}
