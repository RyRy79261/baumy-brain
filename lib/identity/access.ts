import { type Database } from '@/db/client'
import { loadRoster, setDashboardAccess } from '@/lib/identity/roster'
import { writeAudit } from '@/lib/audit'

export type AccessResult = 'granted' | 'revoked' | 'denied' | 'no-such-member' | 'invalid'

// Apply a dashboard-access change on behalf of a dashboard actor. This is the
// grant/revoke that USED to be the /grant /revoke chat commands; its home is now the
// dashboard, where the owner's authenticated session IS the authority (no Telegram
// tap). Defenses, all re-checked LIVE against the DB (never trusting the caller):
//   - OWNER-ONLY: only the house owner may change access;
//   - lock-out guard: the owner can never revoke their OWN access;
//   - the target must be an existing member (a real id).
// Group-admin status is deliberately NOT consulted here — it's a read-side hint only,
// never an authorization signal (that would delegate grants to the Telegram admin graph).
export async function applyMemberAccess(
  db: Database,
  actorUid: string,
  targetUserId: string,
  allow: boolean,
): Promise<AccessResult> {
  if (!/^\d+$/.test(targetUserId)) return 'invalid'
  const roster = await loadRoster(db)
  if (!roster.isOwner(Number(actorUid))) return 'denied'
  if (targetUserId === actorUid && !allow) return 'denied' // never self-revoke (lock-out)
  const ok = await setDashboardAccess(db, targetUserId, allow)
  if (!ok) return 'no-such-member'
  await writeAudit(db, allow ? 'dashboard.grant' : 'dashboard.revoke', actorUid, targetUserId, null)
  return allow ? 'granted' : 'revoked'
}
