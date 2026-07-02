import type { TelegramUpdate } from '@/lib/telegram/schema'

// Origin resolution (architecture D9 / task-graph S5). Pure, no I/O.
// Classifies WHO sent an update and WHAT trust their text carries — the
// deterministic input to the write-gate. The LLM proposes; this disposes.

export type Source = 'owner' | 'member' | 'unauthorized'
export type Lane = 'house' | 'member_dm' | 'ignore'
// 'quarantined' = forwarded/bot-origin content (memory-core #7/#94): stored for
// provenance but NEVER grounds a reply, NEVER attributed to a housemate, NEVER
// privileged. 'untrusted' = native group text: grounds replies (context only),
// never privileged. 'trusted' = a known member's own DM text.
export type Trust = 'trusted' | 'untrusted' | 'quarantined' | 'system'

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

export interface OriginParts {
  chatId: string
  fromId: number | null
  text: string | null
  isPrivate: boolean
  /** from.is_bot — bot-origin content is quarantined. */
  isBot?: boolean
  /** message.forward_origin/forward_date present — forwarded content is quarantined. */
  isForwarded?: boolean
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

// `houseChatId` is the house group id — resolved by the caller from house_config
// (auto-captured when the bot is added). Falls back to the BAUMY_HOUSE_CHAT_ID
// env override when a caller omits it (e.g. unit tests).
export function resolveOriginParts(p: OriginParts, roster: Roster, houseChatId?: string): Origin {
  const house = houseChatId ?? process.env.BAUMY_HOUSE_CHAT_ID ?? ''
  const { chatId, fromId, text, isPrivate } = p
  const isOwner = fromId != null && roster.isOwner(fromId)
  // Forwarded or bot-origin content is quarantined regardless of lane (injection
  // wall, memory-core #7/#94): it never grounds a reply, is never attributed to a
  // housemate, and can never be privileged — even in a trusted member DM.
  const quarantined = p.isBot === true || p.isForwarded === true

  // House lane: everyone in the house group is a housemate (B10). Their text is
  // ALWAYS untrusted for privileged actions (privacy mode is OFF → injection
  // wall); it can only become memory, a reply, or a (fixed-destination) reminder.
  // owner/member is attribution only.
  if (house !== '' && chatId === house) {
    return { source: isOwner ? 'owner' : 'member', lane: 'house', memoryTrust: quarantined ? 'quarantined' : 'untrusted', privileged: false, chatId, fromId, text }
  }

  // Member-DM lane: a private chat from a KNOWN member — house-management only.
  // Forwarded/bot content the member relays is quarantined + non-privileged.
  if (isPrivate && fromId != null && roster.isMember(fromId)) {
    return { source: isOwner ? 'owner' : 'member', lane: 'member_dm', memoryTrust: quarantined ? 'quarantined' : 'trusted', privileged: !quarantined, chatId, fromId, text }
  }

  // Unknown DM sender / out-of-scope → ignored.
  return { ...IGNORE, chatId, fromId, text }
}

export function resolveOrigin(update: TelegramUpdate, roster: Roster, houseChatId?: string): Origin {
  const msg = update.message ?? update.edited_message
  if (!msg) return IGNORE
  return resolveOriginParts(
    {
      chatId: String(msg.chat.id),
      fromId: msg.from?.id ?? null,
      text: msg.text ?? null,
      isPrivate: msg.chat.type === 'private',
      isBot: msg.from?.is_bot === true,
      isForwarded: msg.forward_origin != null || msg.forward_date != null,
    },
    roster,
    houseChatId,
  )
}
