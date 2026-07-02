import { cookies } from 'next/headers'
import { verifySession, SESSION_COOKIE } from '@/lib/auth/session'

export const runtime = 'nodejs'

export default async function AdminPage() {
  const jar = await cookies()
  const session = verifySession(jar.get(SESSION_COOKIE)?.value)

  return (
    <main style={{ fontFamily: 'system-ui', padding: '3rem', maxWidth: 720, margin: '0 auto' }}>
      <h1>🌳 Baumy — house dashboard</h1>
      <p>
        Signed in as Telegram user <code>{session?.uid}</code>.
      </p>
      <p style={{ color: '#888' }}>
        Memory browser, member management, reminders, scheduled tasks, response-policy, and cost views land here.
      </p>
    </main>
  )
}
