import { requireOwner } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { memberDisplayNames } from '@/lib/identity/roster'
import { houseTz } from '@/lib/env'
import { pendingWork, type PendingReminder } from '@/lib/console/pending'
import { houseTimeline } from '@/lib/console/timeline'
import { page, th, td } from '@/lib/dashboard/styles'

export const runtime = 'nodejs'

// The console (docs/spec/sandbox-console.md) — OWNER ONLY. The rest of /admin is member-visible;
// this surface shows the machinery (trust tiers, supersession chains, pending work) and is gated
// separately. requireOwner re-checks the live roster on every request; the layout's requireAdmin
// is not enough on its own, so this page re-gates rather than trusting the wrapper.

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(d)

const rel = (d: Date, now: Date) => {
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000)
  const abs = Math.abs(mins)
  const unit = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`
  return mins >= 0 ? `in ${unit}` : `${unit} ago`
}

const chip = (bg: string, fg = '#333'): React.CSSProperties => ({
  background: bg,
  color: fg,
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  marginLeft: 6,
  whiteSpace: 'nowrap',
})

const TRUST_CHIP: Record<string, React.CSSProperties> = {
  system: chip('#e8e2ff'),
  trusted: chip('#dff0d8'),
  untrusted: chip('#f4f4f4', '#777'),
  quarantined: chip('#ffe0e0', '#a33'),
}

function ReminderRows({ rows, now, tz, tone }: { rows: PendingReminder[]; now: Date; tz: string; tone?: string }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.id}>
          <td style={{ ...td, color: tone }}>
            {r.anchorKind === 'event_offset' ? '🗓️' : '⏰'} {r.content}
          </td>
          <td style={{ ...td, whiteSpace: 'nowrap', color: '#888' }}>
            {fmt(r.fireAt, tz)} <span style={{ color: '#aaa' }}>· {rel(r.fireAt, now)}</span>
          </td>
        </tr>
      ))}
    </>
  )
}

export default async function ConsolePage() {
  const session = await requireOwner()
  if (!session) {
    return (
      <main style={page}>
        <h1>🧠 Console</h1>
        <p style={{ color: '#888' }}>This surface is owner-only.</p>
      </main>
    )
  }

  const db = createHttpDb()
  const groupId = await getHouseChatId(db)
  if (!groupId) {
    return (
      <main style={page}>
        <h1>🧠 Console</h1>
        <p style={{ color: '#888' }}>No house group on file yet — add Baumy to the group and it captures the id.</p>
      </main>
    )
  }

  const tz = houseTz()
  // One wall-clock read, passed down. Every view below is a pure function of (data, now) — which is
  // what lets Phase 2 render this same page at a simulated timestamp.
  const now = new Date()
  const p = await pendingWork(db, groupId, now)
  const timeline = await houseTimeline(db, groupId, 25)
  const names = await memberDisplayNames(db)
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? id) : null)

  const section: React.CSSProperties = { marginTop: '2rem' }
  const muted: React.CSSProperties = { color: '#888', fontSize: 13 }

  return (
    <main style={page}>
      <h1>🧠 Console</h1>
      <p style={muted}>
        House <code>{groupId}</code> · {tz} · as of {fmt(now, tz)}
      </p>

      <h2 style={section}>About to happen</h2>
      {p.due.length + p.upcoming.length + p.stale.length + p.stuck.length === 0 ? (
        <p style={muted}>Nothing scheduled.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {p.due.length > 0 && (
              <tr>
                <th style={{ ...th, paddingTop: '0.8rem' }} colSpan={2}>
                  Due now <span style={muted}>· the next digest delivers these</span>
                </th>
              </tr>
            )}
            <ReminderRows rows={p.due} now={now} tz={tz} />
            {p.upcoming.length > 0 && (
              <tr>
                <th style={{ ...th, paddingTop: '0.8rem' }} colSpan={2}>
                  Upcoming
                </th>
              </tr>
            )}
            <ReminderRows rows={p.upcoming} now={now} tz={tz} />
            {p.stale.length > 0 && (
              <tr>
                <th style={{ ...th, paddingTop: '0.8rem' }} colSpan={2}>
                  <span style={{ color: '#a33' }}>Too late to send</span>{' '}
                  <span style={muted}>· past the 24h window — these get cancelled, not delivered</span>
                </th>
              </tr>
            )}
            <ReminderRows rows={p.stale} now={now} tz={tz} tone="#a33" />
            {p.stuck.length > 0 && (
              <tr>
                <th style={{ ...th, paddingTop: '0.8rem' }} colSpan={2}>
                  <span style={{ color: '#a33' }}>Stuck mid-send</span> <span style={muted}>· the reaper has not run yet</span>
                </th>
              </tr>
            )}
            <ReminderRows rows={p.stuck} now={now} tz={tz} tone="#a33" />
          </tbody>
        </table>
      )}

      <h2 style={section}>Events it knows about</h2>
      {p.horizon.length === 0 ? (
        <p style={muted}>No dated events in the next 8 days.</p>
      ) : (
        <ul style={{ paddingLeft: '1.1rem' }}>
          {p.horizon.map((f) => (
            <li key={f.id}>
              {f.subject} <span style={{ color: '#888' }}>{f.predicate.replace(/_/g, ' ')}</span> {f.objectValue}
              <span style={{ color: '#aaa' }}> · {fmt(f.eventAt, tz)}</span>
            </li>
          ))}
        </ul>
      )}
      {p.orphaned.length > 0 && (
        <p style={{ ...muted, color: '#a33' }}>
          {p.orphaned.length} scheduled heads-up{p.orphaned.length === 1 ? '' : 's'} anchored to a fact that is no longer current — the
          nightly consolidation cancels these.
        </p>
      )}
      {p.undated.length > 0 && <p style={muted}>{p.undated.length} recent fact(s) with no resolved date — catch-up candidates.</p>}

      <h2 style={section}>Waiting on a human</h2>
      {p.confirms.length === 0 ? (
        <p style={muted}>No confirm cards pending.</p>
      ) : (
        <ul style={{ paddingLeft: '1.1rem' }}>
          {p.confirms.map((c) => (
            <li key={c.id}>
              <code>{c.actionType}</code>
              {c.requestedBy && <span style={{ color: '#888' }}> · asked by {nameOf(c.requestedBy)}</span>}
              <span style={c.expired ? { ...chip('#ffe0e0', '#a33') } : chip('#f4f4f4', '#777')}>
                {c.expired ? 'expired' : `expires ${rel(c.expiresAt, now)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.loginLinks > 0 && (
        <p style={muted}>
          {p.loginLinks} unused dashboard login link{p.loginLinks === 1 ? '' : 's'} still valid.
        </p>
      )}

      <h2 style={section}>What it made of what we said</h2>
      <p style={muted}>Each message with the facts it produced and the heads-ups those facts scheduled.</p>
      {timeline.length === 0 ? (
        <p style={muted}>Nothing captured yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {timeline.map((m) => (
            <li key={m.id} style={{ borderTop: '1px solid #f0f0f0', padding: '0.7rem 0' }}>
              <div>
                {m.isSecure && <span title="secret — only a descriptor is stored">🔒 </span>}
                {m.content}
              </div>
              <div style={muted}>
                {nameOf(m.authoredBy) ?? 'unattributed'} · {fmt(m.createdAt, tz)}
                <span style={TRUST_CHIP[m.trustLevel] ?? TRUST_CHIP.untrusted}>{m.trustLevel}</span>
                <span style={chip('#f4f4f4', '#777')}>{m.memoryType}</span>
              </div>
              {m.facts.length > 0 && (
                <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', fontSize: 14 }}>
                  {m.facts.map((f) => (
                    <li key={f.id} style={{ color: f.isCurrent ? undefined : '#aaa' }}>
                      🧠 {f.subject} <span style={{ color: '#888' }}>{f.predicate.replace(/_/g, ' ')}</span>{' '}
                      {f.isSecure ? <em style={{ color: '#888' }}>(secret — value encrypted)</em> : f.objectValue}
                      {!f.isCurrent && <span style={chip('#f4f4f4', '#999')}>superseded</span>}
                      {f.eventAt && <span style={chip('#eef4ff', '#456')}>{fmt(f.eventAt, tz)}</span>}
                      {f.reminders.map((r) => (
                        <div key={r.id} style={{ color: '#888', fontSize: 13 }}>
                          ↳ 🗓️ {r.content} <span style={{ color: '#aaa' }}>· {fmt(r.fireAt, tz)} · {r.status}</span>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
