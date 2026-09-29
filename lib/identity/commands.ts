import { randomUUID } from 'node:crypto'
import { createHttpDb, type Database } from '@/db/client'
import { loadRoster, setDmChatId } from '@/lib/identity/roster'
import { issueLoginToken } from '@/lib/auth/tokens'
import { setGlobalEnabled } from '@/lib/policy'
import { writeAudit } from '@/lib/audit'
import { sendDmLoginResponse } from '@/lib/telegram/client'
import { START_MESSAGE } from '@/lib/ai/prompts'
import type { Origin } from '@/lib/core/origin'
import { callOlympicsAction } from '@/lib/olympics/client'
import { NOT_CONNECTED, UNAVAILABLE } from '@/lib/olympics/intents'

// House-management commands over the member-DM lane (deterministic; no LLM).
// origin.chatId for a member DM is that member's private chat id.
// `messageId` (the command's Telegram message) keys the /link Idempotency-Key, so a retried step
// replays Olympics' stored answer instead of claiming the one-time code a second time.
export async function handleCommand(origin: Origin, text: string, db: Database = createHttpDb(), opts: { messageId?: number } = {}): Promise<void> {
  const parts = text.trim().split(/\s+/)
  // Strip a "@botusername" suffix so "/dashboard@baumy_bot" === "/dashboard".
  const cmd = (parts[0] ?? '').split('@')[0].toLowerCase()

  // Orientation + first-DM capture. Reaches here only in the member-DM lane, so the
  // caller is a known housemate — record their DM chat id for future proactive DMs.
  if (cmd === '/start') {
    if (origin.fromId != null) await setDmChatId(db, String(origin.fromId), origin.chatId)
    // Olympics' "Link Telegram" button opens t.me/<bot>?start=link_<code>; Telegram then sends
    // `/start link_<code>` from the member's own DM when they tap Start. It is exactly `/link <code>`
    // (same action, same Idempotency-Key shape, same replies). DM only by construction: this path
    // runs only in the member-DM lane, and a /start in the group is ignored (I7).
    const deepLink = START_LINK.exec(parts[1] ?? '')
    if (deepLink && origin.fromId != null) {
      await sendDmLoginResponse(origin.chatId, await linkTelegram(String(origin.fromId), deepLink[1], linkKey(origin, opts)))
      return
    }
    await sendDmLoginResponse(origin.chatId, START_MESSAGE)
    return
  }

  if (cmd === '/dashboard') {
    if (origin.fromId == null) return
    const roster = await loadRoster(db)
    if (!roster.canAccessDashboard(origin.fromId)) {
      await sendDmLoginResponse(origin.chatId, "You don't have dashboard access yet — ask the house owner to grant it.")
      return
    }
    const raw = await issueLoginToken(db, String(origin.fromId))
    const base = process.env.BAUMY_PUBLIC_URL ?? ''
    await sendDmLoginResponse(
      origin.chatId,
      `Here's your one-time dashboard link (expires in 5 minutes):\n${base}/api/auth/login?token=${raw}`,
    )
    return
  }

  // Member/dashboard management (list / grant / revoke) lives in the web dashboard,
  // not in chat commands — you can see who's in the group already, and grants are a
  // one-tap toggle there (with a "group admin → grant?" hint). No /housemates,
  // /grant, /revoke.

  if (cmd === '/pause' || cmd === '/resume') {
    const roster = await loadRoster(db)
    if (origin.fromId == null || !roster.isOwner(origin.fromId)) {
      await sendDmLoginResponse(origin.chatId, 'Only the house owner can pause or resume Baumy.')
      return
    }
    // Kill-switch: applied immediately (a "go quiet" control should not itself
    // need a second tap). Owner-authenticated + audited; untrusted text can never
    // reach this. Always reversible with the opposite command / the dashboard.
    const enable = cmd === '/resume'
    await setGlobalEnabled(db, enable)
    await writeAudit(db, enable ? 'policy.resume' : 'policy.pause', String(origin.fromId), null, null)
    await sendDmLoginResponse(
      origin.chatId,
      enable ? '▶️ Baumy resumed — replies and reminders are back on.' : '⏸️ Baumy paused — it will stay quiet (still captures memory) until /resume.',
    )
    return
  }

  if (cmd === '/link') {
    if (origin.fromId == null) return
    await sendDmLoginResponse(origin.chatId, await linkTelegram(String(origin.fromId), parts[1] ?? '', linkKey(origin, opts)))
    return
  }

  await sendDmLoginResponse(origin.chatId, 'Unknown command.')
}

// ── /link <code> — Baumy Olympics member linking (docs/spec/olympics.md) ─────────────────────────
// The member creates a one-time code in Olympics → Settings and DMs it here. Olympics' `link_telegram`
// maps the code to its member and records THIS Telegram id — the authenticated sender (X-Baumy-Actor),
// never anything in the text. The one Olympics action an unlinked Telegram user may call.

/** The deep-link payload Olympics puts after `?start=`: `link_<code>` (Telegram allows [A-Za-z0-9_-]). */
const START_LINK = /^link_([A-Za-z0-9]{8,32})$/

/** One key per Telegram message, so a retried step replays Olympics' answer instead of re-claiming. */
function linkKey(origin: Origin, opts: { messageId?: number }): string {
  return `tglink-${origin.chatId}-${opts.messageId ?? randomUUID()}`
}

export const LINK_USAGE = 'Send it like this: /link ABCD1234EF — get the code in Baumy Olympics → Settings → Link Telegram (it lasts 10 minutes), or just tap Open Telegram there. 🔗'
const LINK_CODE = /^[A-Za-z0-9]{8,32}$/

export async function linkTelegram(telegramId: string, code: string, idempotencyKey: string): Promise<string> {
  const c = code.trim()
  if (!LINK_CODE.test(c)) return LINK_USAGE
  const r = await callOlympicsAction<{ memberId: string; displayName: string }>('link_telegram', { code: c }, { actor: telegramId, idempotencyKey })
  if (r.ok) return `🔗 Linked — you're ${r.data?.displayName ?? 'in'} in Baumy Olympics. You can now ask me to add calendar events and log your chores.`
  if (r.kind === 'not_configured') return NOT_CONNECTED
  if (r.kind === 'unavailable') return UNAVAILABLE
  if (r.code === 'LINK_CODE_INVALID') return "That code didn't work — it's wrong, already used or expired (codes last 10 minutes). Create a new one in Olympics → Settings. 🔗"
  if (r.code === 'TELEGRAM_ALREADY_LINKED')
    return 'This Telegram account is already linked to another Olympics member. An Olympics admin can clear it on the members page. 🔗'
  if (r.code === 'RATE_LIMITED') return 'Too many tries — wait a few minutes, then send /link again. 🔗'
  if (r.code === 'INVALID_INPUT') return LINK_USAGE
  return `⚠️ ${r.message}`
}
