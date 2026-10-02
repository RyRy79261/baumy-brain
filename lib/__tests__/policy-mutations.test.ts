import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { loadResponsePolicy, setGlobalEnabled, addMutedTopic, removeMutedTopic, setReplyFrequency } from '@/lib/policy'
import { auditLog, houseConfig } from '@/db/schema'

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

describe('policy writes are field patches with an atomic audit row (PR #13 review)', () => {
  it('writes the change and its audit row together', async () => {
    const db = await makeTestDb()
    await setReplyFrequency(db, 'chatty', { actor: '42', action: 'policy.reply_frequency', metadata: { level: 'chatty' } })
    expect((await loadResponsePolicy(db)).reply_frequency).toBe('chatty')
    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'policy.reply_frequency', actorMemberId: '42', metadata: { level: 'chatty' } })
  })

  it('a failing statement leaves neither the change nor an audit row', async () => {
    const db = await makeTestDb()
    await expect(
      // action is NOT NULL: the audit insert fails, so the whole statement rolls back, the policy included.
      setGlobalEnabled(db, false, { actor: '42', action: null as unknown as string }),
    ).rejects.toThrow()
    expect((await loadResponsePolicy(db)).global_enabled).toBe(true)
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('a write built from a stale read cannot undo another field', async () => {
    const db = await makeTestDb()
    // Two housemates at once: one pauses, the other mutes a topic. Neither reads the whole document.
    await Promise.all([setGlobalEnabled(db, false), addMutedTopic(db, 'politics'), setReplyFrequency(db, 'chatty')])
    const p = await loadResponsePolicy(db)
    expect(p.global_enabled).toBe(false)
    expect(p.muted_topics).toEqual(['politics'])
    expect(p.reply_frequency).toBe('chatty')
  })

  it('seeds the singleton when it does not exist yet', async () => {
    const db = await makeTestDb()
    await db.delete(houseConfig)
    await addMutedTopic(db, 'Bins')
    const p = await loadResponsePolicy(db)
    expect(p.muted_topics).toEqual(['bins'])
    expect(p.global_enabled).toBe(true)
  })
})
