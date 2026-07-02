import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/constants'

// Dashboard shell gate (spec A1/D22). This is a cheap edge fast-path that bounces
// obviously-unauthenticated traffic away from /admin. It is NOT the security
// boundary — the real authorization is requireAdmin() in the RSC layer, which
// re-checks the live grant against the DB on every request. Machine endpoints
// (/api/telegram/webhook, /api/inngest) are excluded by the matcher and keep
// their own auth (secret-token header / Inngest signature); /api/auth/login must
// stay public (it is the session minter), so it is not gated here either.
export function middleware(req: NextRequest) {
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = { matcher: ['/admin/:path*'] }
