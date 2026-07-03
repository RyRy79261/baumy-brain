import { describe, it, expect } from 'vitest'
import { makeTestDb, fakeEmbed } from './pglite'
import { memoryItems, memoryEmbeddings } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { EMBED_MODEL } from '@/lib/ai/embed'

// The "current-embedding-model-only" invariant: every semantic arm (retrieve's
// hybrid probe + write's findDuplicate) filters `me.model = EMBED_MODEL`, so a row
// embedded under a STALE/other model (a leftover from a re-embed, or a different
// vector space) is never cosine-compared against a current-model query — mixing
// embedding spaces in one column is meaningless. These tests fail if that filter
// is deleted from either query.

const GROUP = '-100test'
const embed = async (t: string) => fakeEmbed(t)

// A model id that is deliberately NOT the current embedder — e.g. a vector left
// behind by a previous embedding model before a re-embed completed.
const STALE_MODEL = 'voyage-stale-v0'

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')

describe('current-embedding-model-only invariant', () => {
  it('sanity: STALE_MODEL is not the production embedder', () => {
    expect(STALE_MODEL).not.toBe(EMBED_MODEL)
  })

  it('retrieve: a stale-model embedding never surfaces through the semantic arm', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)

    const QUERY = 'when do the plants get watered'
    // A genuine item embedded under the CURRENT model — it should surface normally.
    await captureMemory(
      { groupId: GROUP, content: 'the plants get watered friday', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )

    // A DISTINCT item whose content is lexically disjoint from the query (so the
    // NON-model-filtered lexical arm can never surface it), but whose ONLY embedding
    // is the query vector itself (cosine 1.0) stored under a STALE model. If the
    // `me.model = EMBED_MODEL` filter were removed, this row would rank #1 and the
    // assertion below would fail.
    const [stale] = await db
      .insert(memoryItems)
      .values({ groupId: GROUP, sourceKind: 'message', memoryType: 'fact', content: 'quokka zimblat frobnax', authoredBy: '100', trustLevel: 'untrusted' })
      .returning({ id: memoryItems.id })
    await db.insert(memoryEmbeddings).values({ memoryItemId: stale.id, model: STALE_MODEL, embedding: fakeEmbed(QUERY) })

    const res = await retrieve(QUERY, { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.some((r) => r.content.includes('plants get watered'))).toBe(true) // current-model item grounds
    expect(res.some((r) => r.id === stale.id)).toBe(false) // stale-model-only item never surfaces
  })

  it('findDuplicate: a stale-model near-duplicate does not trigger consolidation', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)

    const INCOMING = 'bins go out on tuesday'
    // A pre-existing item whose ONLY embedding is the incoming vector (cosine 1.0,
    // well above the 0.97 dedup threshold) but stored under a STALE model. Without
    // the model filter, captureMemory below would consolidate onto THIS row and
    // return its id instead of storing the fresh (current-model) memory.
    const [stale] = await db
      .insert(memoryItems)
      .values({ groupId: GROUP, sourceKind: 'message', memoryType: 'fact', content: 'stale placeholder note', authoredBy: '100', trustLevel: 'untrusted' })
      .returning({ id: memoryItems.id })
    await db.insert(memoryEmbeddings).values({ memoryItemId: stale.id, model: STALE_MODEL, embedding: fakeEmbed(INCOMING) })

    const newId = await captureMemory(
      { groupId: GROUP, content: INCOMING, memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed },
    )
    expect(newId).not.toBe(stale.id) // stored fresh, NOT consolidated onto the stale row

    // And it landed under the current model, so it is actually recallable.
    const res = await retrieve('when do the bins go out', { groupId: GROUP, floor: 0 }, { db, embed })
    expect(res.some((r) => r.id === newId)).toBe(true)
  })
})
