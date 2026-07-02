import { NextResponse, type NextRequest } from 'next/server'
import { createHttpDb } from '@/db/client'
import { consumeLoginToken } from '@/lib/auth/tokens'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'

// Magic-link landing: consume the one-time token, mint a session cookie, → /admin.
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return new NextResponse('Missing token', { status: 400 })

  const userId = await consumeLoginToken(createHttpDb(), token)
  if (!userId) return new NextResponse('Invalid or expired login link.', { status: 401 })

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
