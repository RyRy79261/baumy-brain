import type { TelegramUpdate } from '@/lib/telegram/schema'

// Origin resolution (architecture D9 / task-graph S5). Pure, no I/O.
// Classifies WHO sent an update and WHAT trust their text carries — the
// deterministic input to the write-gate. The LLM proposes; this disposes.

export type Source = 'owner' | 'member' | 'unauthorized'
export type Lane = 'house' | 'member_dm' | 'ignore'
export type Trust = 'trusted' | 'untrusted' | 'system'

export interface Origin {
  source: Source
  lane: Lane
  memoryTrust: Trust
  /** May this text drive a privileged action? Group text NEVER can (injection wall). */
  privileged: boolean
  chatId: string
  fromId: number | null
  text: string | null
}

export interface Roster {
  isOwner: (id: number) => boolean
  isMember: (id: number) => boolean
}

const IGNORE: Origin = {
  source: 'unauthorized',
  lane: 'ignore',
  memoryTrust: 'untrusted',
  privileged: false,
  chatId: '',
  fromId: null,
  text: null,
}

export function resolveOrigin(update: TelegramUpdate, roster: Roster): Origin {
  const msg = update.message ?? update.edited_message
  if (!msg) return IGNORE

  const houseChatId = process.env.BAUMY_HOUSE_CHAT_ID ?? ''
  const chatId = String(msg.chat.id)
  const fromId = msg.from?.id ?? null
  const text = msg.text ?? null
  const isOwner = fromId != null && roster.isOwner(fromId)

  // House lane: everyone in the house group is a housemate (B10). Their text is
  // ALWAYS untrusted for privileged actions (privacy mode is OFF → injection
  // wall); it can only become memory or a reply. owner/member is attribution.
  if (chatId === houseChatId) {
    return {
      source: isOwner ? 'owner' : 'member',
      lane: 'house',
      memoryTrust: 'untrusted',
      privileged: false,
      chatId,
      fromId,
      text,
    }
  }

  // Member-DM lane: a private chat from a KNOWN member — house-management only.
  if (msg.chat.type === 'private' && fromId != null && roster.isMember(fromId)) {
    return {
      source: isOwner ? 'owner' : 'member',
      lane: 'member_dm',
      memoryTrust: 'trusted',
      privileged: true, // gated further by the action policy (owner vs member)
      chatId,
      fromId,
      text,
    }
  }

  // Unknown DM sender / out-of-scope → ignored.
  return { ...IGNORE, chatId, fromId, text }
}
