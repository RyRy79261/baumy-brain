import { GrammyError } from 'grammy'
import { and, eq } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { houseConfig, members, replies } from '@/db/schema'
import { postMessage, postConfirmCard } from '@/lib/telegram/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { writeAudit } from '@/lib/audit'
import { now as clockNow } from '@/lib/core/clock'
import type { ChatDestination } from '@/lib/core/origin'

// The ONE outbound door for Baumy's words (fixed-destination invariant, architecture D9). The caller
// names WHERE in code — never an LLM, never message text — as one of three destinations:
//
//   • chat   — the chat a message came from (addressingFor's `reply`: the house group echoing its forum
//              topic, or the authenticated sender's own DM). Optionally a Telegram reply to it (C11).
//   • house  — a proactive house post (a reminder, the digest, a heads-up): resolved HERE to the CURRENT
//              live transport id + the /notifyhere topic, and SELF-HEALS a group→supergroup migration
//              (a stale-id 400 persists the new id and retries once; the memory scope is never touched).
//   • member — one active housemate's own DM (a personal reminder, D2). Refused (thrown) for anyone who
//              is not an active member — a departed creator's reminder is retired, never re-routed.
//
// Every send is appended to the 48h conversation window at the transport exit (lib/telegram/client.ts),
// `windowText` replacing what is stored when the sent text must not linger. The sandbox capture is
// enforced there too.

export type Destination = ChatDestination | { to: 'house' } | { to: 'member'; memberId: string }

export interface SendOpts {
  /** Send as a Telegram reply to this message (C11). */
  replyTo?: number
  silent?: boolean
  /** What the conversation window keeps instead of the text (a secret, a sign-in link, a card's target). */
  windowText?: string
}

/** Thrown when a destination is not on the allow-list — loud, so the caller's retry/retire logic runs. */
export class DestinationRefused extends Error {}

export async function send(dest: Destination, text: string, opts: SendOpts = {}, db: Database = createHttpDb()): Promise<void> {
  const post = { silent: opts.silent, replyToMessageId: opts.replyTo, windowText: opts.windowText }
  if (dest.to === 'chat') return postMessage(dest.chatId, text, { ...post, threadId: dest.threadId ?? undefined })
  if (dest.to === 'member') return postMessage(await memberDm(db, dest.memberId), text, post)
  return sendToLiveHouse(db, text, post)
}

/** An inline-keyboard confirm card (security B4) into the chat the request came from. */
export async function sendConfirm(dest: ChatDestination, text: string, actionId: string, opts: Pick<SendOpts, 'replyTo' | 'windowText'> = {}): Promise<void> {
  return postConfirmCard(dest.chatId, text, actionId, dest.threadId ?? undefined, opts.replyTo, opts.windowText)
}

// A housemate's DM: a private chat's id IS the member's Telegram user id. Active members only.
async function memberDm(db: Database, memberId: string): Promise<string> {
  const [m] = await db
    .select({ id: members.telegramUserId })
    .from(members)
    .where(and(eq(members.telegramUserId, memberId), eq(members.isActive, true)))
    .limit(1)
  if (!m) throw new DestinationRefused(`[baumy/send] ${memberId} is not an active housemate — no DM sent`)
  return m.id
}

// The new -100… supergroup id Telegram hands back when you send to a STALE (pre-upgrade) group id:
// HTTP 400 "group chat was upgraded to a supergroup chat", with parameters.migrate_to_chat_id set to
// the new id (docs/spec/telegram.md D9). Anything else is a real error and must propagate.
function migrateTargetFrom(e: unknown): string | null {
  if (e instanceof GrammyError && e.error_code === 400 && e.parameters?.migrate_to_chat_id != null) {
    return String(e.parameters.migrate_to_chat_id)
  }
  return null
}

// A proactive house post. A non-migration failure propagates so the caller's exactly-once
// release/retry (reminders.md) still runs. An inbound reply needs none of this: it already lands on the
// live id (the message would not have been heard otherwise).
async function sendToLiveHouse(db: Database, text: string, post: { silent?: boolean; replyToMessageId?: number; windowText?: string }): Promise<void> {
  const { sendId, reminderThreadId } = await resolveHouseIds(db)
  const opts = { ...post, threadId: reminderThreadId ?? undefined }
  try {
    await postMessage(sendId, text, opts)
  } catch (e) {
    const newId = migrateTargetFrom(e)
    if (!newId || newId === sendId) throw e
    // Converge the transport id (scope untouched) so every later send goes straight to the supergroup.
    await db.update(houseConfig).set({ liveChatId: newId, migratedFromChatId: sendId, updatedAt: clockNow() }).where(eq(houseConfig.id, true))
    await writeAudit(db, 'house.migrated', null, null, { from: sendId, to: newId, via: 'send-400' }).catch(() => {})
    await postMessage(newId, text, opts) // retry once against the new id (same topic)
  }
}

// ── Exactly one reply per inbound message (D12) ──────────────────────────────────────────────────────
// The claim is keyed on the update id and autocommits (neon-http); the send is fallible and there is no
// sweeper backstop, so a failed send must RELEASE the claim or one Telegram/LLM hiccup drops the reply.

/** True only for the FIRST claim of an update id. */
export async function claimReply(db: Database, updateId: number): Promise<boolean> {
  const rows = await db.insert(replies).values({ updateId }).onConflictDoNothing().returning({ updateId: replies.updateId })
  return rows.length > 0
}

/** Release a claim so the retry re-claims and re-sends. */
export async function releaseReply(db: Database, updateId: number): Promise<void> {
  await db.delete(replies).where(eq(replies.updateId, updateId))
}
