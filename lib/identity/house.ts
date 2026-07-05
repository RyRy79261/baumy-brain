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
