import { NextResponse, type NextRequest } from 'next/server'
import { createHttpDb } from '@/db/client'
import { consumeLoginToken } from '@/lib/auth/tokens'
import { loadRoster } from '@/lib/identity/roster'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'

// Magic-link landing: consume the one-time token, mint a session cookie, → /admin.
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return new NextResponse('Missing token', { status: 400 })

  const db = createHttpDb()
  const userId = await consumeLoginToken(db, token)
  if (!userId) return new NextResponse('Invalid or expired login link.', { status: 401 })

  // Re-authorize at redeem (spec D2/D8): the grant may have been revoked between
  // the link being issued and clicked — never mint a session for a revoked member.
  const roster = await loadRoster(db)
  if (!roster.canAccessDashboard(Number(userId))) {
    return new NextResponse('Your dashboard access is not active.', { status: 403 })
  }

  const res = NextResponse.redirect(new URL('/admin', req.url))
  res.cookies.set(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return res
}
