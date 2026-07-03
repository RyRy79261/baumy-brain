import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { loadResponsePolicy, setGlobalEnabled, addMutedTopic, removeMutedTopic } from '@/lib/policy'

describe('response policy mutations (dashboard settings)', () => {
  it('toggles global_enabled and edits muted topics, persisting via the singleton', async () => {
    const db = await makeTestDb()
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true)

    await setGlobalEnabled(db, false)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(false)

    await addMutedTopic(db, 'Politics')
    await addMutedTopic(db, 'politics') // normalised to lowercase + de-duped
    expect((await loadResponsePolicy(db)).muted_topics).toEqual(['politics'])
    // the pause state survives a muted-topic write (same singleton row)
    expect((await loadResponsePolicy(db)).global_enabled).toBe(false)

    await removeMutedTopic(db, 'politics')
    expect((await loadResponsePolicy(db)).muted_topics).toEqual([])
  })
})
