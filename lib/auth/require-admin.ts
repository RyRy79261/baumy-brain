import { cookies } from 'next/headers'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { verifySession } from '@/lib/auth/session'
import { SESSION_COOKIE } from '@/lib/auth/constants'

// Per-request dashboard authorization (spec D2/D8/A1). The signed session cookie
// proves IDENTITY only; the GRANT (can_access_dashboard AND is_active) is
// re-checked against the live roster on EVERY request. A revoked or deactivated
// member therefore loses access immediately — the admit decision is NEVER cached
// in the cookie. loadRoster fails closed (only the env owner is trusted) if the
// DB is unreachable, so an outage denies rather than admits.
export async function requireAdmin(): Promise<{ uid: string } | null> {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (!session) return null
  const roster = await loadRoster(createHttpDb())
  if (!roster.canAccessDashboard(Number(session.uid))) return null
  return session
}

// Stricter gate for OWNER-only surfaces (privileged config: grants, response policy).
// Re-checks the live owner role + grant, never the cookie. Loads the roster ONCE (the old
// requireAdmin→loadRoster + a second loadRoster read the DB twice and could disagree under
// a transient error).
export async function requireOwner(): Promise<{ uid: string } | null> {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)
  if (!session) return null
  const roster = await loadRoster(createHttpDb())
  const uid = Number(session.uid)
  return roster.canAccessDashboard(uid) && roster.isOwner(uid) ? session : null
}
