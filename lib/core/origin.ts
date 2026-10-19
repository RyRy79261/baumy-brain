import type { TelegramUpdate } from '@/lib/telegram/schema'

// Origin resolution (architecture D9 / task-graph S5). Pure, no I/O.
// Classifies WHO sent an update and WHAT trust their text carries — the
// deterministic input to the write-gate. The LLM proposes; this disposes.

export type Source = 'owner' | 'member' | 'unauthorized'
export type Lane = 'house' | 'member_dm' | 'ignore'
// 'quarantined' = BOT-origin content (memory-core #7/#94): stored for provenance but NEVER grounds a
// reply, NEVER attributed to a housemate, NEVER privileged. 'forwarded' = a message a housemate
// FORWARDED (someone else's words — the landlord's notice, the council's letter; spec D4): stored and
// recallable, but only ever LABELLED "forwarded by X" — never X's own words, never a fact, never an
// action, never privileged. 'untrusted' = native group text: grounds replies (context only), never
// privileged. 'trusted' = a known member's own DM text.
export type Trust = 'trusted' | 'untrusted' | 'forwarded' | 'quarantined' | 'system'

/** Content that is not the sender's own words (forwarded, or bot-origin): it never writes a fact, never
 *  drives an action (reminder / list / forget / follow-up) and is never attributed to the sender. */
export function isRelayed(t: Trust): boolean {
  return t === 'quarantined' || t === 'forwarded'
}

export interface Origin {
  source: Source
  lane: Lane
  memoryTrust: Trust
  /** May this text drive a privileged action? Group text NEVER can (injection wall). */
  privileged: boolean
  chatId: string
  fromId: number | null
  text: string | null
  /** An anonymous-admin post: Telegram sends from=@GroupAnonymousBot with sender_chat = the house
   *  group. It is untrusted HOUSE text (not quarantined), but the from id is a shared bot identity,
   *  so it must never be attributed to (or registered as) a housemate (I8). */
  anonymous?: boolean
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
  /** message.forward_origin present — a housemate relaying someone else's words: trust 'forwarded'. */
  isForwarded?: boolean
  /** message.sender_chat.id — set when a user posts "as the group" (anonymous admin) or a linked
   *  channel auto-forwards. Only sender_chat === the house itself de-quarantines (I8). */
  senderChatId?: string | null
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
// `acceptHouseIds` is the alias set (docs/spec/telegram.md D9): every chat id that counts as the
// house — the stable scope id AND the current live transport id after a supergroup migration. A
// message from ANY of them is the house lane; scope is still derived via addressingFor from
// the stable scope id (passed as `houseChatId`), never from the inbound chat. Omitted (tests / the
// pre-migration case) → just the single `houseChatId`. All ids come from Telegram-authenticated
// transport fields / stored config, never message text, so the injection wall holds.
export function resolveOriginParts(p: OriginParts, roster: Roster, houseChatId?: string, acceptHouseIds?: string[]): Origin {
  const house = houseChatId ?? process.env.BAUMY_HOUSE_CHAT_ID ?? ''
  const accept = acceptHouseIds && acceptHouseIds.length > 0 ? acceptHouseIds : house !== '' ? [house] : []
  const { chatId, fromId, text, isPrivate } = p
  const isOwner = fromId != null && roster.isOwner(fromId)
  // Bot-origin content is quarantined regardless of lane (injection wall, memory-core #7/#94): it never
  // grounds a reply, is never attributed to a housemate, and can never be privileged — even in a
  // trusted member DM. A message a housemate FORWARDED is 'forwarded' (spec D4): recallable, labelled
  // with the forwarder, but just as unprivileged and fact-free (isRelayed). A forwarded bot post stays
  // quarantined.
  //
  // Exception (I8): an anonymous-admin post arrives from=@GroupAnonymousBot (is_bot) with
  // sender_chat = the house group ITSELF. That is a housemate speaking as the group — native house
  // text, so untrusted (never privileged), not quarantined. Only an exact match on the house's own
  // alias set counts; a linked channel's auto-forward (sender_chat = the channel) stays quarantined.
  // Both ids are Telegram-authenticated transport fields, never message text.
  const anonymous = p.isBot === true && p.senderChatId != null && accept.includes(p.senderChatId) && accept.includes(chatId)
  const quarantined = p.isBot === true && !anonymous
  const forwarded = !quarantined && p.isForwarded === true
  const relayedTrust: Trust | null = quarantined ? 'quarantined' : forwarded ? 'forwarded' : null

  // House lane: everyone in the house group is a housemate (B10). Their text is
  // ALWAYS untrusted for privileged actions (privacy mode is OFF → injection
  // wall); it can only become memory, a reply, or a (fixed-destination) reminder.
  // owner/member is attribution only.
  if (accept.includes(chatId)) {
    return {
      source: isOwner ? 'owner' : 'member',
      lane: 'house',
      memoryTrust: relayedTrust ?? 'untrusted',
      privileged: false,
      chatId,
      fromId,
      text,
      ...(anonymous ? { anonymous: true } : {}),
    }
  }

  // Member-DM lane: a private chat from a KNOWN member — house-management only.
  // Forwarded/bot content the member relays keeps its relayed tier and is never privileged.
  if (isPrivate && fromId != null && roster.isMember(fromId)) {
    return { source: isOwner ? 'owner' : 'member', lane: 'member_dm', memoryTrust: relayedTrust ?? 'trusted', privileged: relayedTrust == null, chatId, fromId, text }
  }

  // Unknown DM sender / out-of-scope → ignored.
  return { ...IGNORE, chatId, fromId, text }
}

export function resolveOrigin(update: TelegramUpdate, roster: Roster, houseChatId?: string, acceptHouseIds?: string[]): Origin {
  const msg = update.message ?? update.edited_message
  if (!msg) return IGNORE
  return resolveOriginParts(
    {
      chatId: String(msg.chat.id),
      fromId: msg.from?.id ?? null,
      text: msg.text ?? null,
      isPrivate: msg.chat.type === 'private',
      isBot: msg.from?.is_bot === true,
      isForwarded: msg.forward_origin != null,
      senderChatId: msg.sender_chat?.id != null ? String(msg.sender_chat.id) : null,
    },
    roster,
    houseChatId,
    acceptHouseIds,
  )
}

// ── Addressing: scope, destination and identity, produced ONCE from the origin ──────────────────────
//
// Three things a message has, kept distinct (docs/spec/dm-queries-and-house-scoping.md):
//   • SCOPE — the house whose shared memory it reads/writes. Derived ONLY from the authenticated lane,
//     never from message text or the inbound chat (injection wall I1): a member cannot name another
//     house's scope. house / member_dm → the house's stable scope id; anything else → '' (nothing).
//   • DESTINATION — where a reply may go: the chat it came from (the house group, echoing its forum
//     topic; or the authenticated sender's own DM). Exactly two transport-authenticated targets, never
//     a free or LLM-chosen id. null = the destination belt failed: Baumy says nothing.
//   • IDENTITY — who the words are attributed to (the authenticated sender — never for relayed content,
//     never the shared GroupAnonymousBot behind an anonymous-admin post, I8) and, for a member-forwarded
//     message (D4), who relayed it (recorded beside the note, never as its author).
// In the house group scope and destination collapse into one chat; a member DM is exactly where they
// diverge — scope is the house, the destination is the private chat.
//
// MULTI-HOUSE SEAM: today the members PK is global (one house per human), so the scope is the single
// house. When the baumy_house_members join table lands, scope becomes a per-member lookup
// (resolveHousesForMember → HouseRef[]); the widening happens HERE, not at every call site.

/** A reply into the chat a message came from — the turn's only worded destination. */
export interface ChatDestination {
  to: 'chat'
  chatId: string
  /** The forum topic to echo (house group only); null = General / a DM. */
  threadId: number | null
}

export interface Addressing {
  /** The house whose shared memory this message reads/writes; '' = none. */
  scope: string
  /** Where a reply may go; null = nowhere (the destination belt failed). */
  reply: ChatDestination | null
  /** The housemate the words are attributed to; null for relayed / anonymous / sender-less content. */
  authorId: string | null
  /** Who forwarded it (a member-forwarded message, D4); never its author. */
  forwarderId: string | null
  /** May the 48h conversation window store this message? Never another bot's post (it grounds nothing). */
  windowable: boolean
}

export interface HouseAddress {
  /** The stable memory scope id (house_group_chat_id / the env pin). */
  scopeId: string
  /** Every chat id that counts as the house (the scope id + the live id after a migration). */
  acceptIds: string[]
}

export function addressingFor(origin: Origin, house: HouseAddress, roster: Roster, messageThreadId: number | null): Addressing {
  const inScope = origin.lane === 'house' || origin.lane === 'member_dm'
  const relayed = isRelayed(origin.memoryTrust)
  const sender = origin.fromId != null && !origin.anonymous ? String(origin.fromId) : null
  // The belt re-checks the transport facts the lane was resolved from: the house group's own ids, or a
  // roster member's own private chat. Cheap, and a regression in lane resolution cannot open a target.
  const replyOk =
    (origin.lane === 'house' && house.acceptIds.includes(origin.chatId)) ||
    (origin.lane === 'member_dm' && origin.fromId != null && roster.isMember(origin.fromId) && origin.chatId === String(origin.fromId))
  return {
    scope: inScope ? house.scopeId : '',
    reply: replyOk ? { to: 'chat', chatId: origin.chatId, threadId: origin.lane === 'house' ? messageThreadId : null } : null,
    authorId: relayed ? null : sender,
    forwarderId: origin.memoryTrust === 'forwarded' ? sender : null,
    windowable: inScope && origin.memoryTrust !== 'quarantined',
  }
}
