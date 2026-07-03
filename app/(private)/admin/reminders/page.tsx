import { requireAdmin } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { listReminders } from '@/lib/reminders/store'
import { cancelReminderAction } from '../actions'

export const runtime = 'nodejs'

const page: React.CSSProperties = { padding: '2rem', maxWidth: 760, margin: '0 auto', lineHeight: 1.5 }
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left' }
const td: React.CSSProperties = { padding: '0.4rem 0.5rem', borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }

export default async function RemindersPage() {
  await requireAdmin()
  const db = createHttpDb()
  const groupId = await getHouseChatId(db)
  const rows = groupId ? await listReminders(db, groupId) : []

  return (
    <main style={page}>
      <h1>Reminders</h1>
      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>
          No reminders yet — set one in chat: <em>&ldquo;remind us to pay rent friday&rdquo;</em>.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={th}>When</th>
              <th style={th}>What</th>
              <th style={th}>Status</th>
              <th style={th} aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const active = r.status === 'scheduled' || r.status === 'firing'
              return (
                <tr key={r.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: '#999' }}>{new Date(r.fireAt).toLocaleString()}</td>
                  <td style={td}>{r.content}</td>
                  <td style={{ ...td, color: active ? '#2a7' : '#999' }}>{r.status}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {active && (
                      <form action={cancelReminderAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" style={{ cursor: 'pointer' }}>
                          Cancel
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </main>
  )
}
