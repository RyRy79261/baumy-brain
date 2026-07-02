import { createHttpDb, type Database } from '@/db/client'
import { loadRoster, setDmChatId } from '@/lib/identity/roster'
import { issueLoginToken } from '@/lib/auth/tokens'
import { setGlobalEnabled } from '@/lib/policy'
import { writeAudit } from '@/lib/audit'
import { sendDmLoginResponse } from '@/lib/telegram/client'
import { START_MESSAGE } from '@/lib/ai/prompts'
import type { Origin } from '@/lib/core/origin'

// House-management commands over the member-DM lane (deterministic; no LLM).
// origin.chatId for a member DM is that member's private chat id.
export async function handleCommand(origin: Origin, text: string, db: Database = createHttpDb()): Promise<void> {
  const parts = text.trim().split(/\s+/)
  // Strip a "@botusername" suffix so "/dashboard@baumy_bot" === "/dashboard".
  const cmd = (parts[0] ?? '').split('@')[0].toLowerCase()

  // Orientation + first-DM capture. Reaches here only in the member-DM lane, so the
  // caller is a known housemate — record their DM chat id for future proactive DMs.
  if (cmd === '/start') {
    if (origin.fromId != null) await setDmChatId(db, String(origin.fromId), origin.chatId)
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

  await sendDmLoginResponse(origin.chatId, 'Unknown command.')
}
