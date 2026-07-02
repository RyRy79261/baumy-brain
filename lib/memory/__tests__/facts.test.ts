import { describe, it, expect } from 'vitest'
import { makeTestDb } from './pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'

const GROUP = '-100facts'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')

const F = (subject: string, predicate: string, object: string) => ({ subject, predicate, object })

describe('fact reconcile (trust-gated knowledge graph)', () => {
  it('ADD → NOOP → UPDATE (soft-supersede) on a same-trust contradiction', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('rent', 'due_day', 'friday'), authoredBy: null, trustLevel: t })).toBe('add')
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('rent', 'due_day', 'friday'), authoredBy: null, trustLevel: t })).toBe('noop')
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('rent', 'due_day', 'monday'), authoredBy: null, trustLevel: t })).toBe('update')

    const hits = await currentFactsForQuery(db, GROUP, 'when is the rent due')
    expect(hits.some((h) => h.content.includes('monday'))).toBe(true)
    expect(hits.some((h) => h.content.includes('friday'))).toBe(false) // superseded → not current
  })

  it('a LOWER-trust fact can NEVER overwrite a higher-trust one (poisoning defense)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('landlord', 'phone', '0300'), authoredBy: null, trustLevel: 'trusted' })
    // an untrusted (group / planted) contradiction is rejected, not applied
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: F('landlord', 'phone', '0666'), authoredBy: null, trustLevel: 'untrusted' }),
    ).toBe('rejected')
    const hits = await currentFactsForQuery(db, GROUP, 'landlord phone?')
    expect(hits[0]?.content).toContain('0300') // the trusted value stands
  })

  it('quarantined (forwarded/bot) content never becomes a fact', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: F('x', 'y', 'z'), authoredBy: null, trustLevel: 'quarantined' }),
    ).toBe('rejected')
  })

  it('a secret fact is stored encrypted, not in plaintext', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('wifi', 'password', 'hunter2Berlin'), authoredBy: null, trustLevel: 'trusted' })
    const hits = await currentFactsForQuery(db, GROUP, 'what is the wifi password')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].isSecure).toBe(true)
    expect(hits[0].content).not.toContain('hunter2') // plaintext never surfaces
    expect(hits[0].contentEncrypted).toBeTruthy()
  })
})
