import { requireAdmin } from '@/lib/auth/require-admin'

export const runtime = 'nodejs'

export default async function AdminPage() {
  // Defense in depth: the layout already gates, but every admin surface
  // re-checks the live grant itself (spec D2/D8) rather than trusting the cookie.
  const session = await requireAdmin()

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
