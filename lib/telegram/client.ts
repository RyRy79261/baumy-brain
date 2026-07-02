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

// Fixed-destination send (architecture D9): the ONLY house-content destination
// is BAUMY_HOUSE_CHAT_ID. The classifier/LLM can never choose a recipient.
export async function sendToHouse(text: string, opts?: { silent?: boolean }): Promise<void> {
  const chatId = process.env.BAUMY_HOUSE_CHAT_ID
  if (!chatId) throw new Error('[baumy/telegram] BAUMY_HOUSE_CHAT_ID not set')
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

export async function getMe(): Promise<{
  id: number
  username?: string
  can_read_all_group_messages?: boolean
}> {
  return call('getMe', {})
}
