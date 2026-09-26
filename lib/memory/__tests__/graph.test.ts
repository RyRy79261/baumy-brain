import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import { resolveSeedEntities, connectedEdges, entityTimeline, gatherGraphContext } from '@/lib/memory/graph'
import { withSimulatedTime } from '@/lib/core/clock'

const GROUP = '-100graph'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
const t = 'untrusted' as const
const F = (subject: string, predicate: string, object: string) => ({ subject, predicate, object })

// Build: zosia —sibling of→ felix —owns→ the cave  (a 2-hop chain across three subjects)
async function seedGraph(db: Awaited<ReturnType<typeof makeTestDb>>) {
  await ensureRegistered(db, GROUP, null)
  await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'sibling_of', object: 'felix', objectKind: 'person' }, authoredBy: null, trustLevel: t })
  await reconcileFact(db, { groupId: GROUP, fact: { subject: 'felix', subjectKind: 'person', predicate: 'owns', object: 'the cave', objectKind: 'place' }, authoredBy: null, trustLevel: t })
}

describe('fact-graph traversal (human-like multi-hop knowledge)', () => {
  it('walks cross-subject edges outward from the seed (multi-hop)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    const seeds = await resolveSeedEntities(db, GROUP, 'where is zosia staying')
    expect(seeds.length).toBeGreaterThan(0)
    const rel = (await connectedEdges(db, GROUP, seeds, { maxHops: 2 })).map((e) => `${e.subject} ${e.predicate} ${e.object}`)
    expect(rel).toContain('zosia sibling of felix') // 1 hop
    expect(rel).toContain('felix owns cave') // 2 hops — reached THROUGH felix (the traversal)
  })

  it('respects the hop bound (does not reach beyond it)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    const seeds = await resolveSeedEntities(db, GROUP, 'zosia')
    const rel = (await connectedEdges(db, GROUP, seeds, { maxHops: 1 })).map((e) => `${e.subject} ${e.predicate} ${e.object}`)
    expect(rel).toContain('zosia sibling of felix')
    expect(rel).not.toContain('felix owns cave') // 2 hops away — beyond maxHops:1
  })

  it('reconstructs a subject timeline including superseded (past) entries, newest first (F10)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: t })
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'monday'), authoredBy: null, trustLevel: t }) // supersedes friday
    const [bins] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'bins')))
    const contents = (await entityTimeline(db, GROUP, bins.id)).map((e) => e.content)
    expect(contents.some((c) => c.includes('friday') && c.includes('past'))).toBe(true) // old value, marked past
    expect(contents.some((c) => c.includes('monday') && !c.includes('past'))).toBe(true) // current value
    expect(contents.findIndex((c) => c.includes('monday'))).toBeLessThan(contents.findIndex((c) => c.includes('friday'))) // newest → oldest
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
    const conns = (await gatherGraphContext(db, GROUP, 'where is zosia staying')).filter((i) => i.memoryType === 'connection').map((i) => i.content)
    expect(conns).toContain('zosia sibling of felix')
    expect(conns).toContain('felix owns cave') // the multi-hop answer surfaces without a direct lookup
  })

  it('returns nothing when the query names no known entity (no seeds → no walk)', async () => {
    const db = await makeTestDb()
    await seedGraph(db)
    expect(await resolveSeedEntities(db, GROUP, 'what is quantum chromodynamics')).toEqual([])
    expect(await gatherGraphContext(db, GROUP, 'what is quantum chromodynamics')).toEqual([])
  })
})

// Phase 3 (T2): an event that is over is not a current connection — but the entity timeline still
// tells it, as history, "(past, <date>)" (the "when did Zosia last visit?" answer).
describe('graph + time', () => {
  it('an expired edge drops out of connectedEdges; the timeline keeps it as "(past, Sat 14 Mar 2026)"', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'zosia', subjectKind: 'person', predicate: 'staying_in', object: 'the cave', objectKind: 'place' },
        authoredBy: null,
        trustLevel: t,
        eventAt: new Date('2026-03-13T23:00:00Z'),
        validTo: new Date('2026-03-15T22:59:59.999Z'),
      }),
    )
    await withSimulatedTime(new Date('2026-03-12T18:05:00Z'), () =>
      reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'sibling_of', object: 'felix', objectKind: 'person' }, authoredBy: null, trustLevel: t }),
    )
    const [zosia] = await db.select().from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zosia')))
    await withSimulatedTime(new Date('2026-09-26T10:00:00Z'), async () => {
      const edges = await connectedEdges(db, GROUP, [zosia.id])
      expect(edges.map((e) => e.predicate)).toEqual(['sibling of']) // the March stay is not a current connection
      const tl = await entityTimeline(db, GROUP, zosia.id)
      expect(tl.map((e) => e.content)).toEqual(['zosia sibling of: felix', 'zosia stays in: the cave (past, Sat 14 Mar 2026)']) // newest first; staying_in → stays_in
    })
  })
})

// F10: a busy subject's timeline is its LATEST progression (it used to be the oldest 8, so "left on
// Sunday" never reached the deep tier).
describe('entityTimeline — newest first', () => {
  it('keeps the newest entries of a subject with more facts than the limit', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    for (let i = 1; i <= 10; i++)
      await withSimulatedTime(new Date(Date.parse('2026-09-01T10:00:00Z') + i * 60_000), () =>
        reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: `note_${i}`, object: `v${i}` }, authoredBy: null, trustLevel: t }),
      )
    const [ent] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zosia')))
    const tl = (await entityTimeline(db, GROUP, ent.id)).map((e) => e.content)
    expect(tl).toHaveLength(8)
    expect(tl[0]).toBe('zosia note 10: v10')
    expect(tl.some((c) => c.endsWith(': v1'))).toBe(false)
  })

  it('seeds on the most specific NAMED entity, not the house hub (F4)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'the house', predicate: 'collection_day', object: 'friday' }, authoredBy: null, trustLevel: t })
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'stays_in', object: 'the cave', objectKind: 'place' }, authoredBy: null, trustLevel: t })
    const [zosia] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zosia')))
    expect((await resolveSeedEntities(db, GROUP, 'is zosia staying at our house?'))[0]).toBe(zosia.id)
  })
})
