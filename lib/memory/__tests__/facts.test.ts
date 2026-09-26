import { describe, it, expect } from 'vitest'
import { and, eq, ne } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities, facts, memoryItems } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { reconcileFact, reconcileFactDetailed, currentFactsForQuery, tagMemoryAboutPerson } from '@/lib/memory/facts'
import { withSimulatedTime } from '@/lib/core/clock'
import { forgetMemory } from '@/lib/memory/forget'

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

  it('treats a same-value-different-case restatement as a NOOP (not a spurious supersede)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('sink', 'status', 'fixed'), authoredBy: null, trustLevel: t })).toBe('add')
    // "Fixed" only differs in case/whitespace → same value, so it must NOT supersede.
    expect(await reconcileFact(db, { groupId: GROUP, fact: F('sink', 'status', '  Fixed '), authoredBy: null, trustLevel: t })).toBe('noop')
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
      db.select({ id: entities.id, kind: entities.kind }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zofia')))

    // legacy untyped mention first
    await reconcileFact(db, { groupId: GROUP, fact: F('zofia', 'arrives_on', 'friday'), authoredBy: null, trustLevel: t })
    expect((await kindOf())[0].kind).toBe('thing')

    // later we learn she's a person → the SAME node upgrades, no second entity
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zofia', subjectKind: 'person', predicate: 'is', object: 'a nurse' },
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
    await upsertMember(db, GROUP, '77', 'Felix Brandt', 'member')
    const memberOf = async (canonical: string) =>
      (await db.select({ m: entities.memberId }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, canonical))))[0]?.m

    // "felix" (person) → first-name match on "Felix Brandt" → bridged to member 77
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'felix', subjectKind: 'person', predicate: 'owns', object: 'the cave' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    expect(await memberOf('felix')).toBe('77')

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

    // relationship: object is a person → objectEntityId points to the felix node
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zofia', subjectKind: 'person', predicate: 'sibling_of', object: 'felix', objectKind: 'person' },
      authoredBy: null,
      trustLevel: t,
    })
    const [felix] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'felix')))
    const rel = await edgeOf('sibling_of')
    expect(rel.obj).toBe(felix.id) // a real, traversable edge
    expect(rel.val).toBe('felix') // display string still kept

    // attribute: a plain value → NO edge
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'bins', predicate: 'go_out', object: 'friday', objectKind: 'value' },
      authoredBy: null,
      trustLevel: t,
    })
    expect((await edgeOf('collection_day')).obj).toBeNull() // go_out is a synonym of collection_day (spec §7)
  })

  it('tags an evidence note with the person it is about (sentiment/notes, §3)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const memId = await captureMemory(
      { groupId: GROUP, content: 'not sure who this zofia is tbh', memoryType: 'chatter', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed: async (t: string) => embedSync(t) },
    )
    const extracted = [{ subject: 'zofia', subjectKind: 'person' as const, predicate: 'mentioned_by', object: 'ryan' }]
    const r = await reconcileFactDetailed(db, { groupId: GROUP, fact: extracted[0], authoredBy: '100', trustLevel: 'untrusted' })
    await tagMemoryAboutPerson(db, GROUP, memId, r.subjectEntityId)

    const [zofia] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zofia')))
    const [mem] = await db.select({ about: memoryItems.aboutEntityId }).from(memoryItems).where(eq(memoryItems.id, memId))
    expect(mem.about).toBe(zofia.id) // the note is now filed under Zofia (attributed to ryan)
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
    // an untrusted (group / planted) contradiction is NOT applied — it is kept as a non-current
    // CONFLICT row pointing at the trusted fact (spec §7, F5: surfaced, never silently dropped)
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: F('landlord', 'phone', '0666'), authoredBy: null, trustLevel: 'untrusted' }),
    ).toBe('conflict')
    const hits = await currentFactsForQuery(db, GROUP, 'landlord phone?')
    expect(hits.map((h) => h.content)).toEqual([expect.stringContaining('0300')]) // the trusted value stands, alone
    const [trusted] = await db.select({ id: facts.id }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.objectValue, '0300')))
    const [conflict] = await db.select().from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.objectValue, '0666')))
    expect(conflict).toMatchObject({ isCurrent: false, conflictsWithFactId: trusted.id })
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

describe('fact lineage (origin + familial timeline)', () => {
  it('links a fact to the evidence note it was distilled from (origin)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    const memId = await captureMemory(
      { groupId: GROUP, content: 'zosia is coming today', memoryType: 'fact', authoredBy: '100', trustLevel: 'untrusted' },
      { db, embed: async (t: string) => embedSync(t) },
    )
    await reconcileFact(db, { groupId: GROUP, fact: F('zosia', 'arriving', 'today'), authoredBy: '100', trustLevel: 'untrusted', memoryItemId: memId })
    const [row] = await db
      .select({ src: facts.sourceMemoryItemId, author: facts.authoredBy })
      .from(facts)
      .where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'arrives_on'))) // "arriving" → the canonical arrives_on
    expect(row.src).toBe(memId) // fact → its origin note
    expect(row.author).toBe('100') // ...stated by whom
  })

  it('a superseding fact derives from the incumbent it replaced (walkable both ways)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const t = 'untrusted' as const
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: t })
    const [oldRow] = await db.select({ id: facts.id }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.objectValue, 'friday')))
    await reconcileFact(db, { groupId: GROUP, fact: F('bins', 'go_out', 'monday'), authoredBy: null, trustLevel: t })
    const [newRow] = await db.select({ id: facts.id, derived: facts.derivedFromFactId }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.objectValue, 'monday')))
    expect(newRow.derived).toBe(oldRow.id) // new → old (parent)
    const [oldAfter] = await db.select({ sup: facts.supersededBy }).from(facts).where(eq(facts.id, oldRow.id))
    expect(oldAfter.sup).toBe(newRow.id) // old → new (existing forward pointer) — chain both ways
  })

  it('lineage is a REAL relation only (F8): a correction shows what it replaced; an unrelated fact has no parent', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '10', 'Ryan', 'member')
    await upsertMember(db, GROUP, '20', 'Marco', 'member')
    // Ryan: "Zosia arrives Friday"; Marco, later: "Zosia's getting in Saturday" — under a SYNONYM predicate.
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'arrives_on', object: 'Friday' }, authoredBy: '10', trustLevel: 'untrusted' })
    expect(
      await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'arrival_date', object: 'Saturday' }, authoredBy: '20', trustLevel: 'untrusted' }),
    ).toBe('update') // arrival_date IS arrives_on (F3) → it supersedes
    // A different predicate about her is NOT a child of the arrival — no invented "(follows from …)".
    await reconcileFact(db, { groupId: GROUP, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'sibling_of', object: 'felix' }, authoredBy: '10', trustLevel: 'untrusted' })
    const [sib] = await db.select({ derived: facts.derivedFromFactId }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'sibling_of')))
    expect(sib.derived).toBeNull()

    const hits = await currentFactsForQuery(db, GROUP, 'when does zosia arrive?')
    const arrival = hits.find((h) => h.content.includes('arrives on'))
    expect(arrival?.content).toContain('Saturday')
    expect(hits.some((h) => h.content.includes('Friday') && !h.priorContent)).toBe(false) // the old value is not current
    expect(arrival?.authoredBy).toBe('20') // stated by Marco
    expect(arrival?.priorContent).toContain('Friday') // …replacing what Ryan said
    expect(arrival?.priorAuthoredBy).toBe('10')
  })

  it('a SOFT-FORGOTTEN fact never comes back as a lineage parent (F8)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const zosia = (object: string) => ({ subject: 'zosia', subjectKind: 'person' as const, predicate: 'stays_in', object })
    await reconcileFact(db, { groupId: GROUP, fact: zosia("marco's room"), authoredBy: null, trustLevel: 'untrusted' })
    const [row] = await db.select({ id: facts.id }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'stays_in')))
    await forgetMemory(db, GROUP, { factIds: [row.id], scrubValues: [], noteIds: [], aliasHits: [], mode: 'soft' })
    expect(await reconcileFact(db, { groupId: GROUP, fact: zosia('the cave'), authoredBy: null, trustLevel: 'untrusted' })).toBe('add')
    const hits = await currentFactsForQuery(db, GROUP, 'where is zosia staying')
    expect(hits.map((h) => h.content)).toEqual(['zosia stays in: the cave'])
    expect(hits[0].priorContent).toBeNull()
  })

  it('never surfaces a SECRET lineage parent in the progression', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    // a secret wifi-password fact, then a non-secret follow-up about the SAME subject (wifi)
    await reconcileFact(db, { groupId: GROUP, fact: F('wifi', 'password', 'hunter2Berlin'), authoredBy: null, trustLevel: 'trusted' })
    await reconcileFact(db, { groupId: GROUP, fact: F('wifi', 'channel', '6'), authoredBy: null, trustLevel: 'trusted' })
    const hits = await currentFactsForQuery(db, GROUP, 'what wifi channel are we on')
    const child = hits.find((h) => h.content.includes('channel'))
    expect(child?.priorContent ?? '').not.toContain('hunter2') // the secret parent is redacted from lineage
  })
})

// Phase 3 (spec §6): a dated fact is CURRENT only until its event is over (T2), and a repeat of the
// same triple with a new date is a new occurrence, never a noop that throws the date away (T6).
describe('the time model — expiry and new occurrences', () => {
  const zosia = { subject: 'zosia', subjectKind: 'person' as const, predicate: 'staying_in', object: "chloe's room", objectKind: 'place' as const }
  const march = { eventAt: new Date('2026-03-13T23:00:00Z'), validTo: new Date('2026-03-15T22:59:59.999Z') } // Sat 14 – Sun 15 Mar
  const october = { eventAt: new Date('2026-10-02T22:00:00Z'), validTo: new Date('2026-10-04T21:59:59.999Z') } // Sat 3 – Sun 4 Oct
  // The facts under test — not the structural possessor edge ("chloe's room" —belongs_to→ chloe, F1)
  // that creating the possessive room node records.
  const rowsOf = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
    db.select().from(facts).where(and(eq(facts.groupId, GROUP), ne(facts.predicate, 'belongs_to')))

  it('T2: a stay that is over no longer grounds "who is staying" — but it is kept (still is_current history)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...march }))
    // During the stay it is current …
    const during = await withSimulatedTime(new Date('2026-03-14T12:00:00Z'), () => currentFactsForQuery(db, GROUP, 'is zosia staying here?'))
    expect(during).toHaveLength(1)
    expect(during[0].validTo?.toISOString()).toBe(march.validTo.toISOString())
    // … six months later it is not.
    const later = await withSimulatedTime(new Date('2026-09-26T10:00:00Z'), () => currentFactsForQuery(db, GROUP, 'is zosia staying here?'))
    expect(later).toHaveLength(0)
    const [row] = await rowsOf(db)
    expect(row.isCurrent).toBe(true) // not superseded — it happened; it is just over
  })

  it('T6: the same triple with a new date after the old one is over → a NEW occurrence (history kept, lineage linked)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...march }))
    const r = await withSimulatedTime(new Date('2026-09-28T18:00:00Z'), () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))
    expect(r).toBe('add') // not 'noop' — the October visit is learned
    const rows = await rowsOf(db)
    expect(rows).toHaveLength(2)
    const [old, fresh] = [...rows].sort((a, b) => a.eventAt!.getTime() - b.eventAt!.getTime())
    expect(fresh.eventAt?.toISOString()).toBe(october.eventAt.toISOString())
    expect(fresh.derivedFromFactId).toBe(old.id) // the previous visit is its timeline parent
    const now = await withSimulatedTime(new Date('2026-09-29T10:00:00Z'), () => currentFactsForQuery(db, GROUP, 'zosia'))
    expect(now.map((h) => h.eventAt?.toISOString())).toEqual([october.eventAt.toISOString()])
  })

  it('T6: a new date for a still-upcoming occurrence is a reschedule (supersede); the same date again is a noop', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const at = new Date('2026-09-28T18:00:00Z')
    await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))).toBe('noop')
    const nextWeekend = { eventAt: new Date('2026-10-09T22:00:00Z'), validTo: new Date('2026-10-11T21:59:59.999Z') }
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...nextWeekend }))).toBe('update')
    const live = (await rowsOf(db)).filter((f) => f.isCurrent)
    expect(live.map((f) => f.eventAt?.toISOString())).toEqual([nextWeekend.eventAt.toISOString()])
  })

  it('an undated fact that gets its date later is dated in place; restating a past occurrence is a noop', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const at = new Date('2026-09-28T18:00:00Z')
    await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted' }))
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))).toBe('update')
    const rows = await rowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].validTo?.toISOString()).toBe(october.validTo.toISOString())
    // Months later, someone says it again with the same (past) date — history, not a new visit.
    expect(await withSimulatedTime(new Date('2026-12-01T10:00:00Z'), () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))).toBe('noop')
    expect(await rowsOf(db)).toHaveLength(1)
  })

  it('something said AFTER it happened is history: it never closes the upcoming occurrence', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const at = new Date('2026-09-28T18:00:00Z')
    await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...october }))
    const lastWeekend = { eventAt: new Date('2026-09-25T22:00:00Z'), validTo: new Date('2026-09-27T21:59:59.999Z') }
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: zosia, authoredBy: null, trustLevel: 'untrusted', ...lastWeekend }))).toBe('add')
    const live = await withSimulatedTime(at, () => currentFactsForQuery(db, GROUP, 'zosia'))
    expect(live.map((h) => h.eventAt?.toISOString())).toEqual([october.eventAt.toISOString()]) // the October visit is untouched
    expect((await rowsOf(db)).every((f) => f.isCurrent)).toBe(true)
  })

  it('a past-dated CHANGE of an undated state supersedes it and stays live ("fixed yesterday" over "broken")', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await withSimulatedTime(new Date('2026-09-20T10:00:00Z'), () => reconcileFact(db, { groupId: GROUP, fact: F('kitchen sink', 'status', 'broken'), authoredBy: null, trustLevel: 'untrusted' }))
    const at = new Date('2026-09-26T10:00:00Z')
    const yesterday = { eventAt: new Date('2026-09-24T22:00:00Z'), validTo: new Date('2026-09-25T21:59:59.999Z') } // Fri 25 Sep, all day
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: F('kitchen sink', 'status', 'fixed'), authoredBy: null, trustLevel: 'untrusted', ...yesterday }))).toBe('update')
    const hits = await withSimulatedTime(at, () => currentFactsForQuery(db, GROUP, 'is the kitchen sink fixed'))
    expect(hits.map((h) => h.content)).toEqual([expect.stringContaining('fixed')])
    const live = (await rowsOf(db)).filter((f) => f.isCurrent)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ objectValue: 'fixed', validTo: null }) // holds until superseded …
    expect(live[0].eventAt?.toISOString()).toBe(yesterday.eventAt.toISOString()) // … and keeps WHEN it changed
    // Still trust-gated: a lower-trust past-dated change cannot overwrite a trusted state (kept as a conflict).
    await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: F('boiler', 'status', 'working'), authoredBy: null, trustLevel: 'trusted' }))
    expect(await withSimulatedTime(at, () => reconcileFact(db, { groupId: GROUP, fact: F('boiler', 'status', 'broken'), authoredBy: null, trustLevel: 'untrusted', ...yesterday }))).toBe('conflict')
  })

  it('a dated fact given no end still expires (the timed default: start + 6h)', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await reconcileFact(db, { groupId: GROUP, fact: F('plumber', 'visits_on', 'Thu 1 Oct 09:00'), authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-10-01T07:00:00Z') })
    const [row] = await rowsOf(db)
    expect(row.validTo?.toISOString()).toBe('2026-10-01T13:00:00.000Z')
  })
})
