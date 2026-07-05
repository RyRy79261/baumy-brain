import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import { resolveSeedEntities, connectedEdges, entityTimeline, gatherGraphContext } from '@/lib/memory/graph'

const GROUP = '-100graph'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const t = 'untrusted' as const
const F = (subject: string, predicate: string, object: string) => ({ subject, predicate, object })

// Build: zuzka —sibling of→ charl —owns→ the cave  (a 2-hop chain across three subjects)
async function seedGraph(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await ensureRegistered(db, GROUP, null)
  await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'sibling_of', object: 'charl', objectKind: 'person' }, authoredBy: null, trustLevel: t })
  await reconcileFact(db, { groupId: GROUP, fact: { subject: 'charl', subjectKind: 'person', predicate: 'owns', object: 'the cave', objectKind: 'place' }, authoredBy: null, trustLevel: t })
}

describe('fact-graph traversal (human-like multi-hop knowledge)', () => {
  it('walks cross-subject edges outward from the seed (multi-hop)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    const seeds = await resolveSeedEntities(db, GROUP, 'where is zuzka staying')
    expect(seeds.length).toBeGreaterThan(0)
    const rel = (await connectedEdges(db, GROUP, seeds, { maxHops: 2 })).map((e) => `${e.subject} ${e.predicate} ${e.object}`)
    expect(rel).toContain('zuzka sibling of charl') // 1 hop
    expect(rel).toContain('charl owns cave') // 2 hops — reached THROUGH charl (the traversal)
  })

  it('respects the hop bound (does not reach beyond it)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    const seeds = await resolveSeedEntities(db, GROUP, 'zuzka')
    const rel = (await connectedEdges(db, GROUP, seeds, { maxHops: 1 })).map((e) => `${e.subject} ${e.predicate} ${e.object}`)
    expect(rel).toContain('zuzka sibling of charl')
    expect(rel).not.toContain('charl owns cave') // 2 hops away — beyond maxHops:1
  })

  it('reconstructs a subject timeline including superseded (past) entries, chronologically', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: t })
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'monday'), authoredBy: null, trustLevel: t }) // supersedes friday
    const [bins] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'bins')))
    const contents = (await entityTimeline(db, GROUP, bins.id)).map((e) => e.content)
    expect(contents.some((c) => c.includes('friday') && c.includes('past'))).toBe(true) // old value, marked past
    expect(contents.some((c) => c.includes('monday') && !c.includes('past'))).toBe(true) // current value
    expect(contents.findIndex((c) => c.includes('friday'))).toBeLessThan(contents.findIndex((c) => c.includes('monday'))) // oldest → newest
  })

  it('never leaks a secret value in a timeline (descriptor only)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('wifi', 'password', 'hunter2Berlin'), authoredBy: null, trustLevel: 'trusted' })
    await reconcileFact(db, { groupId: GROUP, fact: F('wifi', 'channel', '6'), authoredBy: null, trustLevel: 'trusted' })
    const [wifi] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'wifi')))
    const contents = (await entityTimeline(db, GROUP, wifi.id)).map((e) => e.content)
    expect(contents.join(' ')).not.toContain('hunter2') // the plaintext secret never appears
    expect(contents.some((c) => c.includes('wifi password'))).toBe(true) // ...but the descriptor does
  })

  it('gatherGraphContext assembles the connected neighborhood for the reply', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    const conns = (await gatherGraphContext(db, GROUP, 'where is zuzka staying')).filter((i) => i.memoryType === 'connection').map((i) => i.content)
    expect(conns).toContain('zuzka sibling of charl')
    expect(conns).toContain('charl owns cave') // the multi-hop answer surfaces without a direct lookup
  })

  it('returns nothing when the query names no known entity (no seeds → no walk)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    expect(await resolveSeedEntities(db, GROUP, 'what is quantum chromodynamics')).toEqual([])
    expect(await gatherGraphContext(db, GROUP, 'what is quantum chromodynamics')).toEqual([])
  })
})
