import { GrammyError } from 'grammy'
import { type Database } from '@/db/client'
import { getChatMemberStatus } from '@/lib/telegram/client'
import { isCapturing } from '@/lib/telegram/outbox'
import { upsertMember } from '@/lib/identity/roster'
import { writeAudit } from '@/lib/audit'

// New housemates (docs/spec/chat-understanding-v2.md §8, K6). Baumy learns the roster from group
// activity (ensureRegistered) and chat_member updates — but Telegram only sends chat_member to a bot
// that is a group ADMIN, so a housemate who joined and has not yet said anything in the group was
// unknown: their DM resolved to the 'ignore' lane and got silence, not even /start.
//
// Now an unknown private sender is checked against Telegram's own membership graph: getChatMember(the
// house's live chat id, their authenticated from.id). An active member (creator / administrator /
// member / a restricted user who is still a member) is upserted into the roster and served as a normal
// member DM; anyone else is ignored exactly as before. The check is FAIL-CLOSED — any transport error is
// "not a member" (and not cached, so their next DM asks again) — and a definite "no" is cached for a
// few minutes, so a stranger spamming the bot costs one Bot API call per window, not one per message.
// Nothing here is derived from message text; the id is Telegram-authenticated, and the answer is
// Telegram's. It grants only what membership grants (the member_dm lane) — never owner, never the
// dashboard.

const NEGATIVE_TTL_MS = 10 * 60_000
const MAX_CACHED = 500
const notMembers = new Map<string, number>() // `${chat}:${user}` → cached-until (ms)

export type MembershipCheck = 'member' | 'not_member' | 'error'

/** Is `userId` an active member of the house group (Telegram's answer)? Never throws. */
export async function checkHouseMembership(houseSendId: string, userId: number, at: number = Date.now()): Promise<MembershipCheck> {
  if (!houseSendId) return 'not_member'
  const key = `${houseSendId}:${userId}`
  // No caching inside a sandbox: its answers come from the harness and must not leak into real traffic.
  const cache = !isCapturing()
  const until = cache ? notMembers.get(key) : undefined
  if (until && until > at) return 'not_member'
  try {
    const m = await getChatMemberStatus(houseSendId, userId)
    if (m?.isMember) {
      notMembers.delete(key)
      return 'member'
    }
    if (cache) remember(key, at)
    return 'not_member'
  } catch (err) {
    // "user not found" / "member not found" is a definite no; anything else fails closed, uncached.
    if (err instanceof GrammyError && err.error_code === 400 && /not found|invalid user/i.test(err.description)) {
      if (cache) remember(key, at)
      return 'not_member'
    }
    console.warn('[baumy/identity] getChatMember failed — treating the sender as unknown:', err instanceof Error ? err.message : err)
    return 'error'
  }
}

function remember(key: string, at: number) {
  if (notMembers.size >= MAX_CACHED) notMembers.delete(notMembers.keys().next().value as string)
  notMembers.set(key, at + NEGATIVE_TTL_MS)
}

/** Test seam: forget every cached "not a member". */
export function clearMembershipCache(): void {
  notMembers.clear()
}

/**
 * An unknown private sender: verify against the house group and, if they are a member, add them to the
 * roster (reactivating a returning housemate) under the house SCOPE, audited. Returns true when they may
 * now be served as a member DM. The role is never set here beyond the default 'member' for a new row.
 */
export async function admitVerifiedMember(
  db: Database,
  house: { scopeId: string; sendId: string },
  userId: number,
  name: string | null,
): Promise<boolean> {
  if (!house.scopeId) return false
  const verdict = await checkHouseMembership(house.sendId || house.scopeId, userId)
  if (verdict !== 'member') return false
  await upsertMember(db, house.scopeId, String(userId), name)
  await writeAudit(db, 'member.verified', null, String(userId), { via: 'getChatMember' }).catch(() => {})
  return true
}
