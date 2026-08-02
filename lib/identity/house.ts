import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'
import type { Lane } from '@/lib/core/origin'

// The house group's chat id. Source of truth is house_config.house_group_chat_id,
// which is auto-captured the moment the bot is added to the group (see
// handleMyChatMember). BAUMY_HOUSE_CHAT_ID is an OPTIONAL override — set it only
// if you want to pin the group explicitly; otherwise the invite decides.
// Returns '' before the bot has been added anywhere (nothing is in scope yet).
export async function getHouseChatId(db: Database): Promise<string> {
  const override = process.env.BAUMY_HOUSE_CHAT_ID
  if (override && override !== '') return override
  const [cfg] = await db.select({ id: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
  return cfg?.id ?? ''
}

// Alias seam (docs/spec/telegram.md D9). A group→supergroup upgrade changes the Telegram
// chat_id, but the SCOPE key (getHouseChatId) must stay put or all memory orphans. So we split:
//   - scopeId  = the stable memory scope (house_group_chat_id / env pin) — group_id everywhere.
//   - sendId   = the CURRENT transport id (live_chat_id if set, else scopeId) — where sends land.
//   - acceptIds = every id that counts as "the house" for inbound lane resolution (both, deduped).
// One query, so the ingest hot path resolves all three at once.
export interface HouseIds {
  scopeId: string
  sendId: string
  acceptIds: string[]
  /** Forum topic proactive reminders post into (the "notification channel"); null = General topic. */
  reminderThreadId: number | null
  /** Forum topic where Baumy is fully conversational (the "ask-Baumy" channel); null = none. */
  consoleThreadId: number | null
}

export async function resolveHouseIds(db: Database): Promise<HouseIds> {
  const override = process.env.BAUMY_HOUSE_CHAT_ID
  const [cfg] = await db
    .select({
      scope: houseConfig.houseGroupChatId,
      live: houseConfig.liveChatId,
      thread: houseConfig.reminderThreadId,
      console: houseConfig.consoleThreadId,
    })
    .from(houseConfig)
    .limit(1)
  // The env pin overrides the SCOPE only (never the live transport id — that is DB-driven,
  // captured from Telegram's migration signal, so a redeploy isn't needed to follow a migration).
  const scopeId = override && override !== '' ? override : (cfg?.scope ?? '')
  const liveId = cfg?.live ?? ''
  const sendId = liveId !== '' ? liveId : scopeId
  const acceptIds = [...new Set([scopeId, sendId].filter((x) => x !== ''))]
  return { scopeId, sendId, acceptIds, reminderThreadId: cfg?.thread ?? null, consoleThreadId: cfg?.console ?? null }
}

// Where a proactive house send (reminder/digest/heads-up) lands: the live transport id, resolving
// to the scope id before any migration. This IS the "code-resolved house group" the fixed-destination
// invariant refers to (reminders.md) — post-alias it's just resolved at send time, not frozen.
export async function getHouseSendId(db: Database): Promise<string> {
  return (await resolveHouseIds(db)).sendId
}

// Detect the owner's reminders-topic command: /notifyhere (pin THIS topic as the notification
// channel) or /notifyoff (reset to the General topic). Strips a @botname suffix; deterministic, no
// false positives. Authorization (owner) + the actual thread id (authenticated message_thread_id)
// are enforced by the caller — never derived from this text.
export function parseNotifyCommand(text: string | null | undefined): 'here' | 'off' | null {
  if (!text) return null
  const m = text.trim().match(/^\/notify(here|off)(?:@\w+)?\b/i)
  return m ? (m[1].toLowerCase() as 'here' | 'off') : null
}

// Detect the owner's ask-Baumy-topic command: /baumyhere (make THIS topic the conversational
// channel) or /baumyoff (turn it off). Same shape/guarantees as parseNotifyCommand.
export function parseConsoleCommand(text: string | null | undefined): 'here' | 'off' | null {
  if (!text) return null
  const m = text.trim().match(/^\/baumy(here|off)(?:@\w+)?\b/i)
  return m ? (m[1].toLowerCase() as 'here' | 'off') : null
}

// Set (or clear, with null) the forum topic that proactive reminders post into. The thread id comes
// from an authenticated inbound message_thread_id (the owner running /notifyhere inside the topic),
// never from message text. Upserts the singleton. Owner-gated + audited at the call site.
export async function setReminderThread(db: Database, threadId: number | null): Promise<void> {
  await db
    .insert(houseConfig)
    .values({ id: true, reminderThreadId: threadId })
    .onConflictDoUpdate({ target: houseConfig.id, set: { reminderThreadId: threadId, updatedAt: new Date() } })
}

// Set (or clear, with null) the ask-Baumy conversational topic. Thread id comes from an authenticated
// inbound message_thread_id (owner running /baumyhere inside the topic), never text. Owner-gated +
// audited at the call site. This only widens VERBOSITY in that topic — never trust/authorization.
export async function setConsoleThread(db: Database, threadId: number | null): Promise<void> {
  await db
    .insert(houseConfig)
    .values({ id: true, consoleThreadId: threadId })
    .onConflictDoUpdate({ target: houseConfig.id, set: { consoleThreadId: threadId, updatedAt: new Date() } })
}

// The house whose SHARED memory a message reads and writes — distinct from where a reply is
// SENT (origin.chatId) and from WHO is speaking (origin.fromId). In the house group all three
// collapse into one chat id; a member DM is exactly where they diverge — scope is the house,
// destination is the private chat. Scope is derived ONLY from the authenticated lane, NEVER
// from message text (injection wall I1): a member cannot name another house's scope.
//
//   house / member_dm → the house group id   (v1: the one house; the member_dm lane already
//                                              required roster membership, so they belong to it)
//   ignore / anything → ''                    (nothing in scope — callers read/write nothing)
//
// MULTI-HOUSE SEAM: today the members PK is global (one house per human), so this returns the
// single house. When the baumy_house_members join table lands this becomes a per-member lookup
// (resolveHousesForMember → HouseRef[]); the widening happens HERE, not at every call site.
// See docs/spec/dm-queries-and-house-scoping.md.
export function houseScopeForOrigin(origin: { lane: Lane }, houseChatId: string): string {
  return origin.lane === 'house' || origin.lane === 'member_dm' ? houseChatId : ''
}
