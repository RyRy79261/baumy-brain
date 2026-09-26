import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { loadResponsePolicy, setGlobalEnabled, setReplyFrequency, setReminderFrequency, replyAllowed, mentionsTopic, type ResponsePolicy } from '@/lib/policy'

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

  it('setReplyFrequency round-trips via the singleton; default is quiet', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('quiet') // default when unseeded (secretary voice)
    await setReplyFrequency(db, 'balanced')
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('balanced')
    await setReplyFrequency(db, 'chatty')
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('chatty')
  })
})

// I10: muted topics match whole words, not substrings.
describe('mentionsTopic — muted topics are whole-word matches', () => {
  it('"bin" mutes the bins, not the cabinet or Robin', () => {
    expect(mentionsTopic('when do the bin bags go out', 'bin')).toBe(true)
    expect(mentionsTopic('when do the BINS go out', 'bin')).toBe(true) // plain plural
    expect(mentionsTopic('the cabinet door is loose', 'bin')).toBe(false)
    expect(mentionsTopic('is Robin moving in?', 'bin')).toBe(false)
    expect(mentionsTopic('binary options lol', 'bin')).toBe(false)
  })
  it('multi-word topics and punctuation boundaries', () => {
    expect(mentionsTopic('who pays the rent money?', 'rent money')).toBe(true)
    expect(mentionsTopic('rent\nmoney', 'rent money')).toBe(true)
    expect(mentionsTopic('(bin)', 'bin')).toBe(true)
    expect(mentionsTopic('anything', '  ')).toBe(false)
  })
  it('replyAllowed honours it', () => {
    expect(replyAllowed({ ...base, muted_topics: ['bin'] }, 0.9, 'is Robin moving in?')).toBe(true)
    expect(replyAllowed({ ...base, muted_topics: ['bin'] }, 0.9, 'bin day?')).toBe(false)
  })
})
