import { requireAdmin } from '@/lib/auth/require-admin'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { loadResponsePolicy } from '@/lib/policy'
import { setPolicyEnabledAction, addMutedTopicAction, removeMutedTopicAction } from '../actions'
import { dailySpendCapUsd } from '@/lib/env'
import { page } from '@/lib/dashboard/styles'

export const runtime = 'nodejs'

export default async function SettingsPage() {
  const session = await requireAdmin()
  const db = createHttpDb()
  const roster = await loadRoster(db)
  const isOwner = session ? roster.isOwner(Number(session.uid)) : false
  const policy = await loadResponsePolicy(db)

  return (
    <main style={page}>
      <h1>Settings</h1>

      <h2>Baumy is {policy.global_enabled ? 'ON' : 'PAUSED'}</h2>
      <p style={{ color: '#888' }}>
        {policy.global_enabled
          ? 'Replying and reminding normally.'
          : 'Staying quiet (still captures memory) until resumed.'}
      </p>
      {isOwner ? (
        <form action={setPolicyEnabledAction}>
          <input type="hidden" name="enabled" value={policy.global_enabled ? 'off' : 'on'} />
          <button type="submit" style={{ cursor: 'pointer' }}>
            {policy.global_enabled ? '⏸️ Pause Baumy' : '▶️ Resume Baumy'}
          </button>
        </form>
      ) : (
        <p style={{ color: '#888' }}>Only the owner can change these.</p>
      )}

      <h2 style={{ marginTop: '2rem' }}>Muted topics</h2>
      <p style={{ color: '#888', fontSize: 14 }}>Baumy won&rsquo;t chime in on messages mentioning these words.</p>
      {policy.muted_topics.length === 0 ? (
        <p style={{ color: '#aaa' }}>None.</p>
      ) : (
        <ul style={{ paddingLeft: '1.2rem' }}>
          {policy.muted_topics.map((t) => (
            <li key={t} style={{ marginBottom: 4 }}>
              {t}{' '}
              {isOwner && (
                <form action={removeMutedTopicAction} style={{ display: 'inline' }}>
                  <input type="hidden" name="topic" value={t} />
                  <button type="submit" style={{ cursor: 'pointer', fontSize: 12, color: '#c33' }}>
                    remove
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <form action={addMutedTopicAction} style={{ marginTop: '0.5rem' }}>
          <input name="topic" placeholder="topic to mute" style={{ padding: '0.3rem' }} />{' '}
          <button type="submit" style={{ cursor: 'pointer' }}>
            Mute
          </button>
        </form>
      )}

      <h2 style={{ marginTop: '2rem' }}>Spend</h2>
      <p style={{ color: '#888', fontSize: 14 }}>
        Usage metering isn&rsquo;t recording yet, so there&rsquo;s nothing to show — spend views land once it&rsquo;s
        wired. Daily cap: <code>${dailySpendCapUsd().toFixed(2)}</code>.
      </p>
    </main>
  )
}
