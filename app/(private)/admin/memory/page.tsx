import { requireAdmin } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { listCurrentFacts, listRecentMemories } from '@/lib/memory/browse'

export const runtime = 'nodejs'

const page: React.CSSProperties = { padding: '2rem', maxWidth: 760, margin: '0 auto', lineHeight: 1.5 }
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left' }
const td: React.CSSProperties = { padding: '0.4rem 0.5rem', borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }

export default async function MemoryPage() {
  await requireAdmin()
  const db = createHttpDb()
  const groupId = await getHouseChatId(db)
  const facts = groupId ? await listCurrentFacts(db, groupId) : []
  const memories = groupId ? await listRecentMemories(db, groupId) : []

  return (
    <main style={page}>
      <h1>What Baumy knows</h1>

      <h2>Facts ({facts.length})</h2>
      {facts.length === 0 ? (
        <p style={{ color: '#888' }}>No facts yet — Baumy distils these as the house talks.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={th}>Subject</th>
              <th style={th}>Predicate</th>
              <th style={th}>Value</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id}>
                <td style={td}>{f.subject}</td>
                <td style={td}>{f.predicate.replace(/_/g, ' ')}</td>
                <td style={td}>{f.isSecure ? '🔒 secret (ask in chat)' : (f.objectValue ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: '2rem' }}>Recent memories ({memories.length})</h2>
      {memories.length === 0 ? (
        <p style={{ color: '#888' }}>Nothing captured yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #ddd' }}>
              <th style={th}>When</th>
              <th style={th}>Note</th>
              <th style={th}>Trust</th>
            </tr>
          </thead>
          <tbody>
            {memories.map((m) => (
              <tr key={m.id}>
                <td style={{ ...td, whiteSpace: 'nowrap', color: '#999' }}>
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                <td style={td}>{m.isSecure ? `🔒 ${m.content}` : m.content}</td>
                <td style={{ ...td, color: m.trustLevel === 'quarantined' ? '#c33' : '#999' }}>{m.trustLevel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ color: '#aaa', fontSize: 13, marginTop: '1.5rem' }}>
        Secrets (wifi, door codes, bank) are stored encrypted and only revealed when asked directly in chat — never
        shown here.
      </p>
    </main>
  )
}
