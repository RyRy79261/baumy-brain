import { cookies } from 'next/headers'
import { verifySession, SESSION_COOKIE } from '@/lib/auth/session'

// Session gate for the whole /admin surface (architecture D3). Machine endpoints
// (/api/telegram, /api/inngest, /api/auth) live outside this group and keep their
// own verification, so they're never gated here.
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)

  if (!session) {
    return (
      <main style={{ fontFamily: 'system-ui', padding: '4rem', maxWidth: 560, margin: '0 auto' }}>
        <h1>🌳 Baumy dashboard</h1>
        <p>
          Access needs a login link. DM the bot <code>/dashboard</code> and it&rsquo;ll send you a one-time link.
        </p>
      </main>
    )
  }
  return <>{children}</>
}
