import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities, facts, memoryItems } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { reconcileFact, currentFactsForQuery, tagMemoryAboutPerson } from '@/lib/memory/facts'

const GROUP = '-100facts'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')

const F = (subject: string, predicate: string, object: string) => ({ subject, predicate, object })

describe('fact reconcile (trust-gated knowledge graph)', () => {
  it('ADD → NOOP → UPDATE (soft-supersede) on a same-trust contradiction', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: t })).toBe('add')
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: t })).toBe('noop')
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'monday'), authoredBy: null, trustLevel: t })).toBe('update')

    const hits = await currentFactsForQuery(db, GROUP, 'when do the bins go out')
    expect(hits.some((h) => h.content.includes('monday'))).toBe(true)
    expect(hits.some((h) => h.content.includes('friday'))).toBe(false) // superseded → not current
  })

  it('resolves surface variants to ONE entity (no fragmentation)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    await reconcileFact(db, { groupId: GROUP, fact: F('the kitchen sink', 'status', 'leaking'), authoredBy: null, trustLevel: t })
    // "the sink" (article stripped → trigram-merged onto "kitchen sink") is the SAME
    // subject+predicate, so this supersedes rather than forking a second entity.
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: F('the sink', 'status', 'fixed'), authoredBy: null, trustLevel: t }),
    ).toBe('update')
    // recall works from either surface form; the superseded value is gone.
    const hits = await currentFactsForQuery(db, GROUP, 'is the sink fixed?')
    expect(hits.some((h) => h.content.includes('fixed'))).toBe(true)
    expect(hits.some((h) => h.content.includes('leaking'))).toBe(false)
  })

  it('types a named human as kind=person and upgrades a legacy thing node (no fragmentation)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    const kindOf = async () =>
      db.select({ id: entities.id, kind: entities.kind }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zuzana')))

    // legacy untyped mention first
    await reconcileFact(db, { groupId: GROUP, fact: F('zuzana', 'arrives_on', 'friday'), authoredBy: null, trustLevel: t })
    expect((await kindOf())[0].kind).toBe('thing')

    // later we learn she's a person → the SAME node upgrades, no second entity
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'is', object: 'a nurse' },
      authoredBy: null,
      trustLevel: t,
    })
    const rows = await kindOf()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('person')
  })

  it('bridges a person to its housemate roster row on a unique name match', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '77', 'Charl Jacobs', 'member')
    const memberOf = async (canonical: string) =>
      (await db.select({ m: entities.memberId }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, canonical))))[0]?.m

    // "charl" (person) → first-name match on "Charl Jacobs" → bridged to member 77
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'charl', subjectKind: 'person', predicate: 'owns', object: 'the cave' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    expect(await memberOf('charl')).toBe('77')

    // a THING is never bridged, even if it name-matches something
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: 'untrusted' })
    expect(await memberOf('bins')).toBeNull()
  })

  it('does NOT bridge an ambiguous name (two members share it)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '1', 'Sam', 'member')
    await upsertMember(db, GROUP, '2', 'Sam', 'member')
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'sam', subjectKind: 'person', predicate: 'is', object: 'around' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    const [e] = await db.select({ m: entities.memberId }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'sam')))
    expect(e.m).toBeNull() // ambiguous → refuse to guess
  })

  it('makes a real graph edge for a relationship object, none for a plain value', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    const edgeOf = async (predicate: string) =>
      (await db.select({ obj: facts.objectEntityId, val: facts.objectValue }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, predicate), eq(facts.isCurrent, true))))[0]

    // relationship: object is a person → objectEntityId points to the charl node
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'sibling_of', object: 'charl', objectKind: 'person' },
      authoredBy: null,
      trustLevel: t,
    })
    const [charl] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'charl')))
    const rel = await edgeOf('sibling_of')
    expect(rel.obj).toBe(charl.id) // a real, traversable edge
    expect(rel.val).toBe('charl') // display string still kept

    // attribute: a plain value → NO edge
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'bins', predicate: 'go_out', object: 'friday', objectKind: 'value' },
      authoredBy: null,
      trustLevel: t,
    })
    expect((await edgeOf('go_out')).obj).toBeNull()
  })

  it('tags an evidence note with the person it is about (sentiment/notes, §3)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const memId = await captureMemory(
      { groupId: GROUP, content: 'not sure who this zuzana is tbh', memoryType: 'chatter', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed: async (t: string) => embedSync(t) },
    )
    const extracted = [{ subject: 'zuzana', subjectKind: 'person' as const, predicate: 'mentioned_by', object: 'ryan' }]
    await reconcileFact(db, { groupId: GROUP, fact: extracted[0], authoredBy: '100', trustLevel: 'untrusted' })
    await tagMemoryAboutPerson(db, GROUP, memId, extracted)

    const [zuzana] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zuzana')))
    const [mem] = await db.select({ about: memoryItems.aboutEntityId }).from(memoryItems).where(eq(memoryItems.id, memId))
    expect(mem.about).toBe(zuzana.id) // the note is now filed under Zuzana (attributed to ryan)
  })

  it('does NOT merge distinct entities (precision on write)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    await reconcileFact(db, { groupId: GROUP, fact: F('marta', 'arrives_on', 'friday'), authoredBy: null, trustLevel: t })
    // a different housemate must NOT collapse into marta — this is an ADD, not an update.
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: F('marco', 'arrives_on', 'sunday'), authoredBy: null, trustLevel: t }),
    ).toBe('add')
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
