import { describe, it, expect, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { auditLog, entities, facts } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { currentFactsForQuery, reconcileFactDetailed } from '@/lib/memory/facts'
import { runHygieneSweep } from '@/lib/memory/hygiene'

// The nightly graph-hygiene sweep (spec §7, F12). Legacy splits are seeded with RAW inserts — reconcile
// no longer produces them, which is exactly why a sweep is needed for the rows written before it.
const GROUP = '-100hygiene'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')
type Db = Awaited<ReturnType<typeof makeTestDb>>
const NOW = new Date('2026-09-27T01:40:00Z')

async function fresh() {
  const db = await makeTestDb()
  await ensureRegistered(db, GROUP, null)
  return db
}
async function entity(db: Db, name: string, kind = 'thing', extra: Partial<typeof entities.$inferInsert> = {}) {
  const [e] = await db.insert(entities).values({ groupId: GROUP, kind, canonicalName: name, ...extra }).returning({ id: entities.id })
  return e.id
}
let minute = 0
async function rawFact(db: Db, subjectEntityId: string, predicate: string, objectValue: string, extra: Partial<typeof facts.$inferInsert> = {}) {
  minute += 1
  const at = new Date(Date.parse('2026-09-01T10:00:00Z') + minute * 60_000)
  const [f] = await db
    .insert(facts)
    .values({ groupId: GROUP, subjectEntityId, predicate, objectValue, trustLevel: 'untrusted', recordedAt: at, validFrom: at, isCurrent: true, ...extra })
    .returning({ id: facts.id })
  return f.id
}
const live = (db: Db) => db.select().from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.isCurrent, true)))

describe('hygiene sweep', () => {
  it('A+D: renames synonym predicates, then the newest of the split becomes the one live value', async () => {
    const db = await fresh()
    const z = await entity(db, 'zuzka', 'person')
    const old = await rawFact(db, z, 'arrives_on', 'friday')
    const fresher = await rawFact(db, z, 'arrival_date', 'saturday')
    const r = await runHygieneSweep(db, GROUP, NOW)
    expect(r.renamed).toBe(1)
    expect(r.resolved).toBe(1)
    const rows = await live(db)
    expect(rows.map((f) => [f.id, f.predicate, f.objectValue])).toEqual([[fresher, 'arrives_on', 'saturday']])
    const [closed] = await db.select().from(facts).where(eq(facts.id, old))
    expect(closed).toMatchObject({ isCurrent: false, supersededBy: fresher })
    expect(rows[0].derivedFromFactId).toBe(old)
  })

  it('D: the trust gate decides — a newer lower-trust row by someone else becomes a conflict; the same author wins', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '1', 'Charli', 'member')
    await upsertMember(db, GROUP, '2', 'Marco', 'member')
    const z = await entity(db, 'zuzka', 'person')
    const dm = await rawFact(db, z, 'stays_in', "charli's room", { trustLevel: 'trusted', authoredBy: '1' })
    const marco = await rawFact(db, z, 'stays_in', 'the cave', { authoredBy: '2' })
    await runHygieneSweep(db, GROUP, NOW)
    expect((await live(db)).map((f) => f.id)).toEqual([dm])
    const [c] = await db.select().from(facts).where(eq(facts.id, marco))
    expect(c).toMatchObject({ isCurrent: false, conflictsWithFactId: dm })

    const m = await entity(db, 'marta', 'person')
    await rawFact(db, m, 'stays_in', 'the attic', { trustLevel: 'trusted', authoredBy: '1' })
    const self = await rawFact(db, m, 'stays_in', 'the cave', { authoredBy: '1' })
    await runHygieneSweep(db, GROUP, NOW)
    expect((await live(db)).filter((f) => f.subjectEntityId === m).map((f) => f.id)).toEqual([self])
  })

  it('D: a multi-valued predicate keeps both guests, dropping only an exact duplicate', async () => {
    const db = await fresh()
    const h = await entity(db, 'house', 'place')
    await rawFact(db, h, 'has_guest', 'marta')
    await rawFact(db, h, 'guest', 'Marta')
    await rawFact(db, h, 'has_guest', 'zuzka')
    await runHygieneSweep(db, GROUP, NOW)
    expect((await live(db)).map((f) => f.objectValue?.toLowerCase()).sort()).toEqual(['marta', 'zuzka'])
  })

  it('B: merges nodes that are provably one — same name, an alias, the same housemate — and audits it', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '1', 'Charli Smith', 'member')
    const a = await entity(db, 'cave', 'place')
    const b = await entity(db, 'Cave', 'place') // a legacy, un-normalised twin
    await rawFact(db, b, 'status', 'free')
    const p1 = await entity(db, 'charli', 'person', { memberId: '1' })
    const p2 = await entity(db, 'charli smith', 'person', { memberId: '1' })
    await rawFact(db, p2, 'is_away', 'this weekend')
    const r = await runHygieneSweep(db, GROUP, NOW)
    expect(r.merged).toBe(2)
    const active = await db.select().from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.isActive, true)))
    expect(active.map((e) => e.id).sort()).toEqual([a, p1].sort())
    expect(active.find((e) => e.id === p1)?.aliases).toContain('charli smith')
    expect((await currentFactsForQuery(db, GROUP, 'is the cave free?')).map((h) => h.content)).toEqual(['cave status: free'])
    expect((await currentFactsForQuery(db, GROUP, 'is charli smith around?')).map((h) => h.content)).toEqual(['charli is away: this weekend'])
    expect((await db.select().from(auditLog)).map((l) => l.action)).toEqual(['memory.entity_merge', 'memory.entity_merge'])
  })

  it('B: never folds nodes of two different housemates, even with the same name', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '1', 'Sam', 'member')
    await upsertMember(db, GROUP, '2', 'Sam', 'member')
    await entity(db, 'sam', 'person', { memberId: '1' })
    await entity(db, 'sam', 'person', { memberId: '2' })
    expect((await runHygieneSweep(db, GROUP, NOW)).merged).toBe(0)
  })

  it('C: the model PROPOSES look-alike things; code offers only safe pairs and disposes', async () => {
    const db = await fresh()
    const shed = await entity(db, 'garden shed', 'place')
    const typo = await entity(db, 'gardn shed', 'place')
    await rawFact(db, typo, 'status', 'locked')
    await entity(db, 'bike shed', 'place')
    await entity(db, 'bike shop', 'org')
    await entity(db, 'marta', 'person')
    await entity(db, 'martha', 'person')
    await entity(db, "charli's room", 'place')
    await entity(db, "charlie's room", 'place')
    const offered: string[] = []
    const proposeMerges = vi.fn(async (pairs: { a: string; b: string }[]) => {
      offered.push(...pairs.map((p) => `${p.a}/${p.b}`))
      return pairs.map((p, i) => (p.a.startsWith('gard') ? i : -1)).filter((i) => i >= 0).concat([99])
    })
    const r = await runHygieneSweep(db, GROUP, NOW, { proposeMerges })
    expect(offered.some((o) => o.includes('marta'))).toBe(false) // people are never offered
    expect(offered.some((o) => o.includes("'s room"))).toBe(false) // nor possessives
    expect(offered).toEqual(expect.arrayContaining([expect.stringMatching(/garden shed|gardn shed/)]))
    expect(r.merged).toBe(1)
    const [kept] = await db.select().from(entities).where(eq(entities.id, typo)) // it had the facts → kept
    expect(kept.isActive).toBe(true)
    expect(kept.aliases).toContain('garden shed')
    const [gone] = await db.select().from(entities).where(eq(entities.id, shed))
    expect(gone.isActive).toBe(false)
  })

  it('E: a conflict row is retired once what it contradicted is no longer live', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 1, 'Charli')
    await ensureRegistered(db, GROUP, 2, 'Marco')
    const put = (object: string, extra: object) =>
      reconcileFactDetailed(db, { groupId: GROUP, fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'stays_in', object }, authoredBy: null, trustLevel: 'untrusted', ...extra })
    await put("charli's room", { trustLevel: 'trusted', authoredBy: '1' })
    const c = await put('the cave', { authoredBy: '2' })
    expect(c.result).toBe('conflict')
    expect((await runHygieneSweep(db, GROUP, NOW)).retired).toBe(0) // still open: the incumbent is live
    await put('the attic', { authoredBy: '1' }) // Charli moves her on — the conflict is moot
    expect((await runHygieneSweep(db, GROUP, NOW)).retired).toBe(1)
    const [row] = await db.select().from(facts).where(eq(facts.id, c.factId!))
    expect(row.deletedAt).not.toBeNull()
  })
})
