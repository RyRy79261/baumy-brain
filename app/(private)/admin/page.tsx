import { requireAdmin } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { loadRoster, listActiveMembers } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { getGroupAdminIds } from '@/lib/telegram/client'
import { setMemberAccessAction } from './actions'

export const runtime = 'nodejs'

export default async function AdminPage() {
  // Defense in depth: the layout already gates, but every admin surface re-checks
  // the live grant itself (spec D2/D8) rather than trusting the cookie.
  const session = await requireAdmin()
  const db = createHttpDb()
  const roster = await loadRoster(db)
  const viewerIsOwner = session ? roster.isOwner(Number(session.uid)) : false
  const members = await listActiveMembers(db)
  // Group-admin status is a HINT only (never auto-grant); best-effort, empty on error.
  const adminIds = await getGroupAdminIds(await getHouseChatId(db))

  const th: React.CSSProperties = { padding: '0.5rem', textAlign: 'left' }
  const td: React.CSSProperties = { padding: '0.5rem', borderTop: '1px solid #f0f0f0' }

  return (
    <main style={{ fontFamily: 'system-ui', padding: '3rem', maxWidth: 760, margin: '0 auto', lineHeight: 1.5 }}>
      <h1>🌳 Baumy — house dashboard</h1>
      <p>
        Signed in as Telegram user <code>{session?.uid}</code>
        {viewerIsOwner ? ' (owner)' : ''}.
      </p>

      <h2 style={{ marginTop: '2rem' }}>Members</h2>
      {!viewerIsOwner && <p style={{ color: '#888' }}>Only the house owner can change dashboard access.</p>}

      {members.length === 0 ? (
        <p style={{ color: '#888' }}>No members on file yet — Baumy discovers them as they talk in the group.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={th}>Member</th>
              <th style={th}>Role</th>
              <th style={th}>Dashboard</th>
              {viewerIsOwner && <th style={th} aria-label="actions" />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isGroupAdmin = adminIds.has(m.id)
              const isOwnerRow = m.role === 'owner'
              return (
                <tr key={m.id}>
                  <td style={td}>
                    {m.name ?? '(no name)'} <span style={{ color: '#aaa' }}>· {m.id}</span>
                    {isGroupAdmin && (
                      <span title="Telegram group admin" style={{ marginLeft: 6, fontSize: 12, color: '#5a8f4e' }}>
                        · group admin
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, color: isOwnerRow ? '#a6631b' : '#888' }}>{m.role}</td>
                  <td style={td}>{isOwnerRow ? '✓ always' : m.dashboard ? '✓ access' : '—'}</td>
                  {viewerIsOwner && (
                    <td style={{ ...td, textAlign: 'right' }}>
                      {isOwnerRow ? null : (
                        <form action={setMemberAccessAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="userId" value={m.id} />
                          <input type="hidden" name="allow" value={m.dashboard ? 'revoke' : 'grant'} />
                          <button type="submit" style={{ cursor: 'pointer' }}>
                            {m.dashboard ? 'Revoke' : isGroupAdmin ? 'Grant (admin)' : 'Grant'}
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <p style={{ color: '#aaa', fontSize: 13, marginTop: '1.5rem' }}>
        Access is explicit — group admins are only <em>suggested</em>, never auto-granted. Memory, reminders, scheduled
        tasks &amp; cost views land here next.
      </p>
    </main>
  )
}
