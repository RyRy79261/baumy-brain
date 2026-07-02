import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { issueLoginToken, consumeLoginToken } from '@/lib/auth/tokens'

describe('magic-link login tokens', () => {
  it('consumes to the user exactly once (single-use)', async () => {
    const db = await makeTestDb()
    const raw = await issueLoginToken(db, '12345')
    expect(await consumeLoginToken(db, raw)).toBe('12345')
    expect(await consumeLoginToken(db, raw)).toBeNull() // already used
  })

  it('rejects an unknown token', async () => {
    const db = await makeTestDb()
    expect(await consumeLoginToken(db, 'not-a-real-token')).toBeNull()
  })

  it('rejects an expired token', async () => {
    const db = await makeTestDb()
    const raw = await issueLoginToken(db, '12345', -10) // already expired
    expect(await consumeLoginToken(db, raw)).toBeNull()
  })
})
