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

export interface OriginParts {
  chatId: string
  fromId: number | null
  text: string | null
  isPrivate: boolean
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

  // House lane: everyone in the house group is a housemate (B10). Their text is
  // ALWAYS untrusted for privileged actions (privacy mode is OFF → injection
  // wall); it can only become memory, a reply, or a (fixed-destination) reminder.
  // owner/member is attribution only.
  if (house !== '' && chatId === house) {
    return { source: isOwner ? 'owner' : 'member', lane: 'house', memoryTrust: 'untrusted', privileged: false, chatId, fromId, text }
  }

  // Member-DM lane: a private chat from a KNOWN member — house-management only.
  if (isPrivate && fromId != null && roster.isMember(fromId)) {
    return { source: isOwner ? 'owner' : 'member', lane: 'member_dm', memoryTrust: 'trusted', privileged: true, chatId, fromId, text }
  }

  // Unknown DM sender / out-of-scope → ignored.
  return { ...IGNORE, chatId, fromId, text }
}

export function resolveOrigin(update: TelegramUpdate, roster: Roster, houseChatId?: string): Origin {
  const msg = update.message ?? update.edited_message
  if (!msg) return IGNORE
  return resolveOriginParts(
    { chatId: String(msg.chat.id), fromId: msg.from?.id ?? null, text: msg.text ?? null, isPrivate: msg.chat.type === 'private' },
    roster,
    houseChatId,
  )
}
