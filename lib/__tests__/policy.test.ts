import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { loadResponsePolicy, setGlobalEnabled, setReplyFrequency, setReminderFrequency, replyAllowed, type ResponsePolicy } from '@/lib/policy'

const base: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [], reply_frequency: 'balanced', reminder_frequency: 'twice' }

describe('response policy (kill-switch + reply gate)', () => {
  it('pause/resume flips global_enabled via the singleton (upsert)', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true) // default when unseeded
    await setGlobalEnabled(db, false)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(false)
    await setGlobalEnabled(db, true)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true)
  })

  it('reminder_frequency: defaults to twice, is settable, and fails closed on garbage', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).reminder_frequency).toBe('twice') // default when unseeded
    await setReminderFrequency(db, 'once')
    expect((await loadResponsePolicy(db)).reminder_frequency).toBe('once')
    await setReminderFrequency(db, 'hourly' as never) // invalid → no-op
    expect((await loadResponsePolicy(db)).reminder_frequency).toBe('once') // unchanged
  })

  it('replyAllowed: paused silences everything; the floor + mutes gate the rest', () => {
    expect(replyAllowed({ ...base, global_enabled: false }, 0.99, 'bins?')).toBe(false) // kill-switch
    expect(replyAllowed(base, 0.5, 'bins?')).toBe(false) // below the 0.7 floor
    expect(replyAllowed(base, 0.9, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, muted_topics: ['bins'] }, 0.9, 'when do the BINS go out')).toBe(false) // muted topic
  })

  it('reply_frequency tunes the volunteered-reply floor', () => {
    // A 0.8-confidence message: chatty (floor 0.5) + balanced (0.7) speak; quiet (0.85) stays quiet.
    expect(replyAllowed({ ...base, reply_frequency: 'chatty' }, 0.8, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, reply_frequency: 'balanced' }, 0.8, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, reply_frequency: 'quiet' }, 0.8, 'bins?')).toBe(false)
    // quiet still answers a very confident one; chatty answers a borderline one balanced would drop.
    expect(replyAllowed({ ...base, reply_frequency: 'quiet' }, 0.9, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, reply_frequency: 'chatty' }, 0.6, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, reply_frequency: 'balanced' }, 0.6, 'bins?')).toBe(false)
  })

  it('setReplyFrequency round-trips via the singleton; default is balanced', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('balanced') // default when unseeded
    await setReplyFrequency(db, 'quiet')
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('quiet')
    await setReplyFrequency(db, 'chatty')
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('chatty')
  })
})
