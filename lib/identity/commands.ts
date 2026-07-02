import { createHttpDb } from '@/db/client'
import { loadRoster, listActiveMembers } from '@/lib/identity/roster'
import { issueLoginToken } from '@/lib/auth/tokens'
import { createPendingAction } from '@/lib/confirm/store'
import { setGlobalEnabled } from '@/lib/policy'
import { writeAudit } from '@/lib/audit'
import { sendDmLoginResponse, sendConfirmCard } from '@/lib/telegram/client'
import type { Origin } from '@/lib/core/origin'

// House-management commands over the member-DM lane (deterministic; no LLM).
// origin.chatId for a member DM is that member's private chat id.
export async function handleCommand(origin: Origin, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase() ?? ''
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
      `Here's your one-time dashboard link (expires in 5 minutes):\n${base}/api/auth/login?token=${raw}`,
    )
    return
  }

  // ── Owner-only house administration ────────────────────────────
  if (cmd === '/housemates') {
    const roster = await loadRoster(db)
    if (origin.fromId == null || !roster.isOwner(origin.fromId)) {
      await sendDmLoginResponse(origin.chatId, 'Only the house owner can list housemates.')
      return
    }
    const mates = await listActiveMembers(db)
    const lines = mates.length
      ? mates.map(
          (m) =>
            `• ${m.name ?? '(no name)'} — id ${m.id}${m.role === 'owner' ? ' (owner)' : ''}${m.dashboard ? ' • dashboard ✓' : ''}`,
        )
      : ['No housemates on file yet.']
    await sendDmLoginResponse(origin.chatId, ['Housemates:', ...lines].join('\n'))
    return
  }

  if (cmd === '/grant' || cmd === '/revoke') {
    const roster = await loadRoster(db)
    if (origin.fromId == null || !roster.isOwner(origin.fromId)) {
      await sendDmLoginResponse(origin.chatId, 'Only the house owner can change dashboard access.')
      return
    }
    const target = (parts[1] ?? '').replace(/^@/, '')
    if (!/^\d+$/.test(target)) {
      await sendDmLoginResponse(origin.chatId, `Usage: ${cmd} <telegram-user-id>  —  run /housemates to see ids.`)
      return
    }
    const grant = cmd === '/grant'
    // Privileged action → a human tap confirms (security B4). Even the owner's own
    // command lands as a confirm card in the DM before it commits.
    const actionId = await createPendingAction(db, {
      groupId: origin.chatId,
      actionType: grant ? 'dashboard.grant' : 'dashboard.revoke',
      payload: { targetUserId: target },
      requestedBy: String(origin.fromId),
      ttlSec: 600,
    })
    await sendConfirmCard(
      origin.chatId,
      `${grant ? 'Grant' : 'Revoke'} dashboard access for user ${target}? Tap to confirm.`,
      actionId,
    )
    return
  }

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

  // /start (binding) lands in a follow-up.
  await sendDmLoginResponse(origin.chatId, 'Unknown command.')
}
