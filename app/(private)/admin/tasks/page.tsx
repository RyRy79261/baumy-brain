import { requireAdmin } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { listTasks } from '@/lib/scheduled-tasks/store'
import { deactivateTaskAction } from '../actions'

export const runtime = 'nodejs'

const page: React.CSSProperties = { padding: '2rem', maxWidth: 760, margin: '0 auto', lineHeight: 1.5 }
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left' }
const td: React.CSSProperties = { padding: '0.4rem 0.5rem', borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }

export default async function TasksPage() {
  const session = await requireAdmin()
  const db = createHttpDb()
  const roster = await loadRoster(db)
  const isOwner = session ? roster.isOwner(Number(session.uid)) : false
  const groupId = await getHouseChatId(db)
  const rows = groupId ? await listTasks(db, groupId) : []

  return (
    <main style={page}>
      <h1>Scheduled tasks</h1>
      <p style={{ color: '#888', fontSize: 14 }}>
        Recurring jobs Baumy runs on its own — the built-in digests, plus anything the house asks it to track.
      </p>
      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>None scheduled.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={th}>Task</th>
              <th style={th}>Cadence</th>
              <th style={th}>Next run</th>
              {isOwner && <th style={th} aria-label="actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td style={td}>
                  {t.prompt === 'digest' ? 'House digest' : t.prompt}
                  {t.isSystem && <span style={{ color: '#aaa', fontSize: 12 }}> · built-in</span>}
                </td>
                <td style={td}>{t.cadence}</td>
                <td style={{ ...td, color: t.isActive ? '#444' : '#aaa' }}>
                  {t.isActive ? (t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—') : 'stopped'}
                </td>
                {isOwner && (
                  <td style={{ ...td, textAlign: 'right' }}>
                    {t.isActive && (
                      <form action={deactivateTaskAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="id" value={t.id} />
                        <button type="submit" style={{ cursor: 'pointer' }}>
                          Stop
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
