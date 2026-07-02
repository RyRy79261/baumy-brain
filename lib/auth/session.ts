import { createHmac, timingSafeEqual } from 'node:crypto'

// Signed stateless session (Phase 6). Decision A1b keeps Better Auth as the
// session layer; this is a lighter HMAC-signed equivalent for a single-tenant
// house bot (swap-in point noted). Format: base64url(payload).hmac.
export const SESSION_COOKIE = 'baumy_session'

function secret(): string {
  const s = process.env.BAUMY_SESSION_SECRET
  if (!s) throw new Error('[baumy/auth] BAUMY_SESSION_SECRET not set')
  return s
}

const nowSec = () => Math.floor(Date.now() / 1000)

export function signSession(userId: string, ttlSec = 60 * 60 * 24 * 30): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: nowSec() + ttlSec })).toString('base64url')
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifySession(token: string | undefined | null): { uid: string } | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null

  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { uid: string; exp: number }
    if (typeof data.uid !== 'string' || data.exp < nowSec()) return null
    return { uid: data.uid }
  } catch {
    return null
  }
}
