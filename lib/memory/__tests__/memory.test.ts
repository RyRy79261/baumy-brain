import { describe, it, expect } from 'vitest'
import { makeTestDb, fakeEmbed } from './pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve, retrieveExpanded } from '@/lib/memory/retrieve'
import { decryptSecret } from '@/lib/core/crypto'

const GROUP = '-100test'
const embed = async (t: string) => fakeEmbed(t)
const embedMany = async (ts: string[]) => ts.map(fakeEmbed)

// Secure-value capture needs the app-side key (lib/core/crypto.ts).
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')

describe('memory store → recall (PGlite + pgvector)', () => {
  it('recalls the semantically-matching item first', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await captureMemory(
      { groupId: GROUP, content: 'rent is due friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    const res = await retrieve('when is the rent due', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].content).toBe('rent is due friday')
    expect(res[0].authoredBy).toBe('100')
  })

  it('scopes retrieval to the group (no cross-group leakage)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await ensureRegistered(db, '-100other', 200)
    await captureMemory(
      { groupId: '-100other', content: 'rent is due friday', memoryType: 'fact', authoredBy: '200', trustLevel: 'untrusted' },
      { db, embed },
    )

    const res = await retrieve('rent due', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.length).toBe(0)
  })

  it('excludes quarantined (forwarded/bot) content from grounding — poisoning defense', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    // a planted/forwarded "fact" — quarantined, must never ground a reply
    await captureMemory(
      { groupId: GROUP, content: 'the door code is 0000', memoryType: 'fact', authoredBy: null, trustLevel: 'quarantined' },
      { db, embed },
    )
    // a genuine housemate fact — untrusted, grounds normally
    await captureMemory(
      { groupId: GROUP, content: 'bins go out on tuesday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    const poison = await retrieve('what is the door code', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(poison.some((r) => r.content.includes('door code'))).toBe(false) // quarantined never surfaces
    const legit = await retrieve('when do the bins go out', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(legit[0]?.content).toBe('bins go out on tuesday') // untrusted still grounds
  })

  it('a secure value is encrypted at rest + embedded only as a descriptor, decryptable on request', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const secret = 'the wifi password is hunter2-Berlin'
    await captureMemory(
      { groupId: GROUP, content: secret, memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    // Recall by descriptor still finds it...
    const res = await retrieve('what is the wifi password', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.length).toBeGreaterThan(0)
    const hit = res[0]
    // ...but neither the stored content nor the embedding hold the secret value.
    expect(hit.content).not.toContain('hunter2')
    expect(hit.isSecure).toBe(true)
    expect(hit.contentEncrypted).toBeTruthy()
    // Decrypt-on-request recovers the literal.
    expect(decryptSecret(hit.contentEncrypted!)).toBe(secret)
  })

  it('query expansion widens recall — a probe surfaces what the raw query floors out', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await captureMemory(
      { groupId: GROUP, content: 'rent is due friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    // The raw query only reaches the rent note; the milk note is below the floor.
    const base = await retrieve('when is the rent due', { groupId: GROUP, floor: 0.2 }, { db, embed })
    expect(base.some((r) => r.content.includes('oat milk'))).toBe(false)
    // An expansion probe ("grocery milk") pulls the milk note in via its lexical arm.
    const expanded = await retrieveExpanded(
      'when is the rent due',
      ['grocery shopping milk'],
      { groupId: GROUP, floor: 0.2 },
      { db, embed, embedMany },
    )
    expect(expanded.some((r) => r.content.includes('rent is due'))).toBe(true)
    expect(expanded.some((r) => r.content.includes('oat milk'))).toBe(true)
  })

  it('consolidation: a near-verbatim restatement bumps the original, not a duplicate', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const id1 = await captureMemory(
      { groupId: GROUP, content: 'bins go out on tuesday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    // said again by someone else — same fact, must consolidate onto the original.
    const id2 = await captureMemory(
      { groupId: GROUP, content: 'bins go out on tuesday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    expect(id2).toBe(id1)
    const res = await retrieve('when do the bins go out', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.filter((r) => r.content.includes('bins')).length).toBe(1) // one item, not two

    // a genuinely different fact is NOT swallowed by dedup.
    const id3 = await captureMemory(
      { groupId: GROUP, content: 'recycling goes out on thursday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    expect(id3).not.toBe(id1)
  })

  it('consolidation never lets a quarantined item swallow a trusted restatement', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    // a forwarded/planted note captured first — quarantined, never grounds a reply.
    await captureMemory(
      { groupId: GROUP, content: 'the spare key is under the mat', memoryType: 'fact', authoredBy: null, trustLevel: 'quarantined' },
      { db, embed },
    )
    // a housemate says the same thing — the real restatement must be stored fresh,
    // not consolidated onto (and bumping) the quarantined row.
    const id2 = await captureMemory(
      { groupId: GROUP, content: 'the spare key is under the mat', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    // retrieval filters quarantined out, so the fact is recallable ONLY if the trusted
    // restatement was actually stored (i.e. dedup did not suppress it).
    const res = await retrieve('where is the spare key', { groupId: GROUP, floor: 0 }, { db, embed })
    const hit = res.find((r) => r.content.includes('spare key'))
    expect(hit?.id).toBe(id2)
  })

  it('a similarity floor filters out unrelated items (honest miss)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    const res = await retrieve('what is the door code', { groupId: GROUP, floor: 0.3 }, { db, embed })
    expect(res.length).toBe(0)
  })
})
