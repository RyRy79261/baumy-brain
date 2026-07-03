import { requireAdmin } from '@/lib/auth/require-admin'

// Authorization gate for the whole /admin surface (architecture D3, spec D2/D8).
// requireAdmin re-checks the LIVE grant against the DB on every request — the
// cookie alone never admits. Machine endpoints (/api/telegram, /api/inngest,
// /api/auth) live outside this group and keep their own verification.
export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin()

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

  const NAV: Array<[string, string]> = [
    ['Members', '/admin'],
    ['Memory', '/admin/memory'],
    ['Reminders', '/admin/reminders'],
    ['Tasks', '/admin/tasks'],
    ['Settings', '/admin/settings'],
  ]
  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <nav
        style={{
          display: 'flex',
          gap: '1.25rem',
          padding: '0.9rem 1.5rem',
          borderBottom: '1px solid #eee',
          fontSize: 14,
          maxWidth: 760,
          margin: '0 auto',
        }}
      >
        <strong style={{ marginRight: 'auto' }}>🌳 Baumy</strong>
        {NAV.map(([label, href]) => (
          <a key={href} href={href} style={{ color: '#444', textDecoration: 'none' }}>
            {label}
          </a>
        ))}
      </nav>
      {children}
    </div>
  )
}
