const API = 'https://api.telegram.org/bot'

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN
  if (!t) throw new Error('[baumy/telegram] TELEGRAM_BOT_TOKEN not set')
  return t
}

async function call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
  if (!json.ok) throw new Error(`[baumy/telegram] ${method} failed: ${json.description ?? 'unknown'}`)
  return json.result as T
}

// Fixed-destination send (architecture D9): the caller resolves the destination
// deterministically (the house group id from house_config, a reminder's stored
// deliver_chat_id, or a task's group_id). The classifier/LLM can NEVER choose it.
export async function sendToHouse(chatId: string, text: string, opts?: { silent?: boolean }): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no house chat id resolved (bot not added to a group yet?)')
  await call('sendMessage', {
    chat_id: chatId,
    text,
    disable_notification: opts?.silent ?? false,
    link_preview_options: { is_disabled: true },
  })
}

// DM reply — permitted ONLY for the auth/login response path to the exact
// originating member (architecture D9). Never for house content.
export async function sendDmLoginResponse(chatId: number | string, text: string): Promise<void> {
  await call('sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  })
}

// Inline-keyboard confirm card (security B4). The tap — a callback_query from a
// member's Telegram-authenticated from.id — is the injection wall for a
// privileged action. callback_data encodes verb + pending-action id.
export async function sendConfirmCard(chatId: string, text: string, actionId: string): Promise<void> {
  if (!chatId) throw new Error('[baumy/telegram] no chat id for confirm card')
  await call('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `c:${actionId}` },
          { text: '✖️ Cancel', callback_data: `x:${actionId}` },
        ],
      ],
    },
    link_preview_options: { is_disabled: true },
  })
}

// Ack a callback_query (dismisses the button spinner; optional toast text).
export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call('answerCallbackQuery', { callback_query_id: callbackId, text })
}

// Rewrite the card after a decision, dropping the keyboard (omit reply_markup).
export async function editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
  await call('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } })
}

export async function getMe(): Promise<{
  id: number
  username?: string
  can_read_all_group_messages?: boolean
}> {
  return call('getMe', {})
}

// Baumy's own @username, fetched once from Telegram (getMe) and cached for the
// process — so "directed at Baumy" detection uses the bot's REAL name, never a
// hardcoded guess.
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
