import type { TelegramUpdate } from '@/lib/telegram/schema'

// Deterministic structural write-gate (architecture D9). No LLM involved.
// Surfaces the inbound lane; privileged effects downstream key off `lane`.
export type Lane = 'house' | 'member_dm' | 'ignore'

export interface GateResult {
  lane: Lane
  chatId: string
  fromId: number | null
  text: string | null
}

export function structuralGate(
  update: TelegramUpdate,
  isKnownMember: (fromId: number) => boolean,
): GateResult {
  const msg = update.message ?? update.edited_message
  if (!msg) return { lane: 'ignore', chatId: '', fromId: null, text: null }

  const houseChatId = process.env.BAUMY_HOUSE_CHAT_ID ?? ''
  const chatId = String(msg.chat.id)
  const fromId = msg.from?.id ?? null
  const text = msg.text ?? null

  // House lane: the trust boundary is chat_id === BAUMY_HOUSE_CHAT_ID.
  if (chatId === houseChatId) return { lane: 'house', chatId, fromId, text }

  // Member-DM lane: private chat from a known member (house-management commands).
  if (msg.chat.type === 'private' && fromId != null && isKnownMember(fromId)) {
    return { lane: 'member_dm', chatId, fromId, text }
  }

  return { lane: 'ignore', chatId, fromId, text }
}
