import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { loadResponsePolicy, setGlobalEnabled, replyAllowed, type ResponsePolicy } from '@/lib/policy'

const base: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [] }

describe('response policy (kill-switch + reply gate)', () => {
  it('pause/resume flips global_enabled via the singleton (upsert)', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true) // default when unseeded
    await setGlobalEnabled(db, false)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(false)
    await setGlobalEnabled(db, true)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true)
  })

  it('replyAllowed: paused silences everything; the floor + mutes gate the rest', () => {
    expect(replyAllowed({ ...base, global_enabled: false }, 0.99, 'bins?')).toBe(false) // kill-switch
    expect(replyAllowed(base, 0.5, 'bins?')).toBe(false) // below the 0.7 floor
    expect(replyAllowed(base, 0.9, 'bins?')).toBe(true)
    expect(replyAllowed({ ...base, muted_topics: ['bins'] }, 0.9, 'when do the BINS go out')).toBe(false) // muted topic
  })
})
