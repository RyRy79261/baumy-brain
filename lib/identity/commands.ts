import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { issueLoginToken } from '@/lib/auth/tokens'
import { sendDmLoginResponse } from '@/lib/telegram/client'
import type { Origin } from '@/lib/core/origin'

// House-management commands over the member-DM lane (deterministic; no LLM).
// origin.chatId for a member DM is that member's private chat id.
export async function handleCommand(origin: Origin, text: string): Promise<void> {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const db = createHttpDb()

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
      `Here's your one-time dashboard link (expires in 10 minutes):\n${base}/api/auth/login?token=${raw}`,
    )
    return
  }

  // /start (binding), /pause, /resume, /grant land in a follow-up.
  await sendDmLoginResponse(origin.chatId, 'Unknown command.')
}
