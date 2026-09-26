// The fact model (docs/spec/chat-understanding-v2.md §7): cardinality + the predicate vocabulary,
// entity resolution that never folds a possessive into its owner, the lookup (whole words, object
// side, the sender as "I", hub ranking, the asked-about author), the trust gate's authenticated
// exceptions + conflict rows, and tagging by resolved id. Replaces the audit repros F1–F7, F13, F15.
import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from './pglite'
import { entities, facts, memoryItems } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { withSimulatedTime } from '@/lib/core/clock'
import {
  reconcileFact,
  reconcileFactDetailed,
  currentFactsForQuery,
  tagMemoryAboutPerson,
  ensureSpeakerEntity,
  type ExtractedFact,
  type ReconcileInput,
} from '@/lib/memory/facts'

const GROUP = '-100factmodel'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
type Db = Awaited<ReturnType<typeof makeTestDb>>

let tick = 0
const base = Date.parse('2026-09-01T10:00:00Z')
// Each write a minute after the last (a real chat is minutes apart; recorded_at orders the lookup).
async function put(db: Db, fact: ExtractedFact, extra: Partial<ReconcileInput> = {}) {
  tick += 1
  return withSimulatedTime(new Date(base + tick * 60_000), () => reconcileFactDetailed(db, { groupId: GROUP, fact, authoredBy: null, trustLevel: 'untrusted', ...extra }))
}
const P = (subject: string, predicate: string, object: string, subjectKind?: ExtractedFact['subjectKind'], objectKind?: ExtractedFact['objectKind']): ExtractedFact => ({
  subject,
  predicate,
  object,
  subjectKind,
  objectKind,
})
const ask = (db: Db, q: string, limit = 5, opts: Parameters<typeof currentFactsForQuery>[5] = {}) =>
  withSimulatedTime(new Date(base + (tick + 1) * 60_000), () => currentFactsForQuery(db, GROUP, q, limit, [], opts)).then((h) => h.map((x) => x.content))

async function fresh() {
  const db = await makeTestDb()
  await ensureRegistered(db, GROUP, null)
  return db
}

describe('cardinality (F2) + the predicate vocabulary (F3)', () => {
  it('a multi-valued predicate accumulates: two guests are both current', async () => {
    const db = await fresh()
    expect((await put(db, P('the house', 'has_guest', 'marta'))).result).toBe('add')
    expect((await put(db, P('the house', 'has_guest', 'zosia'))).result).toBe('add') // NOT a supersede
    expect((await put(db, P('the house', 'has_guest', 'Zosia'))).result).toBe('noop') // the same guest again
    const hits = await ask(db, 'who is staying at the house this weekend?')
    expect(hits).toEqual(expect.arrayContaining(['house has guest: marta', 'house has guest: zosia']))
  })

  it('allergies accumulate; a `removes` fact closes exactly one value', async () => {
    const db = await fresh()
    await put(db, P('marco', 'allergic_to', 'peanuts', 'person'))
    await put(db, P('marco', 'is_allergic_to', 'shellfish', 'person')) // synonym → allergic_to
    expect(await ask(db, 'what is marco allergic to?')).toEqual(expect.arrayContaining(['marco allergic to: peanuts', 'marco allergic to: shellfish']))
    expect((await put(db, { ...P('marco', 'allergic_to', 'peanuts', 'person'), removes: true })).result).toBe('removed')
    expect(await ask(db, 'what is marco allergic to?')).toEqual(['marco allergic to: shellfish'])
    // removing a value that is not on record changes nothing
    expect((await put(db, { ...P('marco', 'allergic_to', 'cats', 'person'), removes: true })).result).toBe('noop')
  })

  it('a single-valued predicate supersedes — also under a synonym ("arrival_date" corrects "arrives_on")', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'arrives_on', 'friday', 'person'))
    expect((await put(db, P('zosia', 'Arrival Date', 'saturday', 'person'))).result).toBe('update')
    expect(await ask(db, 'when does zosia arrive?')).toEqual(['zosia arrives on: saturday'])
  })

  it('an unknown predicate is normalised and single-valued', async () => {
    const db = await fresh()
    await put(db, P('boiler', 'Service-Interval', 'yearly'))
    expect((await put(db, P('boiler', 'service interval', 'every 2 years'))).result).toBe('update')
    const rows = await db.select({ p: facts.predicate }).from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.isCurrent, true)))
    expect(rows).toEqual([{ p: 'service_interval' }])
  })
})

describe('entity resolution (F1, F6)', () => {
  it('"chloe\'s bike" never merges into the person chloe — it gets a possessor EDGE instead', async () => {
    const db = await fresh()
    await put(db, P('chloe', 'location', 'barcelona', 'person'))
    expect((await put(db, P("chloe's bike", 'location', 'the shed'))).result).toBe('add') // not an update of Chloe
    const ents = await db.select({ name: entities.canonicalName, kind: entities.kind, aliases: entities.aliases }).from(entities).where(eq(entities.groupId, GROUP))
    expect(ents.map((e) => e.name)).toEqual(expect.arrayContaining(['chloe', "chloe's bike"]))
    expect(ents.find((e) => e.name === 'chloe')?.aliases ?? []).not.toContain("chloe's bike")
    expect(await ask(db, 'where is chloe?')).toEqual(['chloe location: barcelona'])
    const bike = await ask(db, "where is chloe's bike?")
    expect(bike[0]).toBe("chloe's bike location: the shed") // the more specific name ranks first
    const [edge] = await db.select().from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'belongs_to')))
    const [chloe] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'chloe')))
    expect(edge).toMatchObject({ objectEntityId: chloe.id, trustLevel: 'system', authoredBy: null, isCurrent: true })
  })

  it('a generic "room" never absorbs "X\'s room" — each room keeps its own status', async () => {
    const db = await fresh()
    await put(db, P('the room', 'has', 'a broken blind', 'place'))
    await put(db, P("marco's room", 'status', 'free', 'place'))
    expect((await put(db, P("chloe's room", 'status', 'occupied', 'place'))).result).toBe('add')
    const hits = await ask(db, "is marco's room free?")
    expect(hits[0]).toBe("marco's room status: free")
    expect(hits).not.toContain("chloe's room status: occupied")
  })

  it('a qualified phrase is never folded into its head; a bare head still finds its one qualified node', async () => {
    const db = await fresh()
    await put(db, P('sink', 'status', 'broken'))
    await put(db, P('kitchen sink', 'colour', 'white'))
    const names = (await db.select({ name: entities.canonicalName }).from(entities).where(eq(entities.groupId, GROUP))).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['sink', 'kitchen sink'])) // two nodes

    const db2 = await fresh()
    await put(db2, P('the bathroom tap', 'status', 'dripping'))
    expect((await put(db2, P('the tap', 'status', 'fixed'))).result).toBe('update') // the ONE "… tap" node
  })

  it('the bare head is not stored as an alias: once a second "… tap" exists, "the tap" is no longer either', async () => {
    const db = await fresh()
    await put(db, P('the bathroom tap', 'status', 'dripping'))
    expect((await put(db, P('the tap', 'status', 'fixed'))).result).toBe('update')
    const [bath] = await db.select({ aliases: entities.aliases }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'bathroom tap')))
    expect(bath.aliases ?? []).not.toContain('tap')
    await put(db, P('the kitchen tap', 'status', 'fine'))
    expect((await put(db, P('the tap', 'status', 'leaking'))).result).toBe('add') // ambiguous now → its own node, not the bathroom's
    expect(await ask(db, 'is the bathroom tap fixed?')).toContain('bathroom tap status: fixed')
  })

  it('never trigram-merges two people ("marta" / "martha")', async () => {
    const db = await fresh()
    await put(db, P('marta', 'arrives_on', 'friday', 'person'))
    expect((await put(db, P('martha', 'arrives_on', 'sunday', 'person'))).result).toBe('add')
  })

  it('the speaker is ONE node with every form of their name (F6): "chloe smith" and "chloe" resolve to it', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '11', 'Chloe Smith', 'owner')
    await upsertMember(db, GROUP, '12', 'Marco', 'member')
    const id = await ensureSpeakerEntity(db, GROUP, '11', 'Chloe Smith')
    expect(await ensureSpeakerEntity(db, GROUP, '11', 'Chloe Smith')).toBe(id) // idempotent
    const [ent] = await db.select().from(entities).where(eq(entities.id, id!))
    expect(ent).toMatchObject({ canonicalName: 'chloe', kind: 'person', memberId: '11' })
    expect(ent.aliases).toEqual(['chloe smith'])
    // the extractor files "I'm away" under the display name …
    const r = await put(db, P('Chloe Smith', 'is_away', 'this weekend', 'person'), { authoredBy: '11' })
    expect(r.subjectEntityId).toBe(id)
    // … and a first-name question finds it
    expect(await ask(db, 'is chloe around this weekend?')).toEqual(['chloe is away: this weekend'])
  })

  it('a shared first name is never claimed as an alias', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '21', 'Sam Lee', 'member')
    await upsertMember(db, GROUP, '22', 'Sam Kowalski', 'member')
    const a = await ensureSpeakerEntity(db, GROUP, '21', 'Sam Lee')
    const b = await ensureSpeakerEntity(db, GROUP, '22', 'Sam Kowalski')
    expect(a).not.toBe(b)
    const rows = await db.select({ name: entities.canonicalName, aliases: entities.aliases }).from(entities).where(eq(entities.groupId, GROUP))
    expect(rows.map((r) => r.name).sort()).toEqual(['sam kowalski', 'sam lee'])
    expect(rows.flatMap((r) => r.aliases ?? [])).not.toContain('sam')
  })
})

describe('lookup (F4, F7, F13, the sender as "I")', () => {
  it('matches whole words only: "al" is not in "at all"', async () => {
    const db = await fresh()
    await put(db, P('al', 'owes_rent', '£200', 'person'))
    expect(await ask(db, 'is the bathroom tap fixed at all?')).toEqual([])
    expect(await ask(db, 'does al owe rent?')).toEqual(['al owes rent: £200'])
  })

  it('a named subject outranks the "house" hub (it used to be crowded out of the 5 slots)', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'stays_in', 'the cave', 'person'))
    for (const [p, o] of [['collection_day', 'friday'], ['wifi_provider', 'virgin'], ['needs', 'milk'], ['cleaner_day', 'tuesday'], ['landlord', 'dave'], ['boiler_service', 'october']])
      await put(db, P('the house', p, o))
    const hits = await ask(db, 'is zosia staying at our house this weekend?')
    expect(hits[0]).toBe('zosia stays in: the cave')
    expect(hits.filter((h) => h.startsWith('house')).length).toBeLessThanOrEqual(3) // the hub is capped
  })

  it('finds the OBJECT side: "who is in the cave?"', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'stays_in', 'the cave', 'person', 'place'))
    await put(db, P('marco', 'stays_in', 'the blue room', 'person')) // value-only object
    expect(await ask(db, "who's staying in the cave?")).toEqual(['zosia stays in: the cave'])
    expect(await ask(db, 'who sleeps in the blue room?')).toEqual(['marco stays in: the blue room'])
  })

  it('finds the OBJECT side through the object ENTITY, not just the value text ("the basement" = the cave\'s alias)', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'stays_in', 'the cave', 'person', 'place'))
    const set = await db.update(entities).set({ aliases: ['basement'] }).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'cave'))).returning({ id: entities.id })
    expect(set).toHaveLength(1)
    // "basement" appears nowhere in the stored value ("the cave") and the question cues no predicate —
    // only the object_entity_id arm finds it.
    expect(await ask(db, 'anyone in the basement?')).toEqual(['zosia stays in: the cave'])
  })

  it('"my room" is the SENDER\'s room', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'stays_in', "chloe's room", 'person', 'place'))
    await put(db, P('marta', 'stays_in', "marco's room", 'person', 'place'))
    // Without the sender nothing is named — only the weak "staying" cue, both rooms alike …
    expect(await ask(db, 'who is staying in my room?')).toHaveLength(2)
    // … with it, "my room" from Chloe IS chloe's room, and only that.
    expect(await ask(db, 'who is staying in my room?', 5, { speaker: { memberId: '11', firstName: 'Chloe' } })).toEqual(["zosia stays in: chloe's room"])
  })

  it('"what did Marco say" puts Marco\'s facts first', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 20, 'Marco')
    await ensureRegistered(db, GROUP, 30, 'Rui')
    await put(db, P('gear budget', 'amount', '£400'), { authoredBy: '30' })
    await put(db, P('the plumber', 'visits_on', 'thursday'), { authoredBy: '20' })
    const hits = await ask(db, 'what did marco say about the budget?', 5, { authorId: '20' })
    expect(hits[0]).toBe('plumber visits on: thursday')
    expect(hits).toContain('gear budget amount: £400')
  })

  it('a reflect profile ranks below every direct fact (F11)', async () => {
    const db = await fresh()
    await put(db, P('zosia', 'sibling_of', 'felix', 'person'))
    await put(db, P('zosia', 'profile', "Felix's sister, often visits.", 'person'), { trustLevel: 'system', neverSecret: true })
    const hits = await withSimulatedTime(new Date(base + (tick + 1) * 60_000), () => currentFactsForQuery(db, GROUP, 'who is zosia?'))
    expect(hits.map((h) => h.isProfile)).toEqual([false, true])
  })
})

describe('the trust gate (F5)', () => {
  it('the SAME author corrects their own DM (trusted) fact from the group (untrusted)', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 111, 'Chloe')
    await put(db, P('zosia', 'stays_in', "chloe's room", 'person'), { trustLevel: 'trusted', authoredBy: '111' })
    expect((await put(db, P('zosia', 'stays_in', 'the cave', 'person'), { trustLevel: 'untrusted', authoredBy: '111' })).result).toBe('update')
    expect(await ask(db, 'where is zosia staying?')).toEqual(['zosia stays in: the cave'])
  })

  it('the owner may correct anyone\'s trusted fact', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 111, 'Chloe')
    await ensureRegistered(db, GROUP, 222, 'Marco')
    await put(db, P('bins', 'collection_day', 'friday'), { trustLevel: 'trusted', authoredBy: '222' })
    expect((await put(db, P('bins', 'collection_day', 'thursday'), { authoredBy: '111', authorIsOwner: true })).result).toBe('update')
  })

  it('anyone else gets a non-current CONFLICT row naming what it contradicts — one per value', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 111, 'Chloe')
    await ensureRegistered(db, GROUP, 222, 'Marco')
    const dm = await put(db, P('zosia', 'stays_in', "chloe's room", 'person'), { trustLevel: 'trusted', authoredBy: '111' })
    const c = await put(db, P('zosia', 'stays_in', 'the cave', 'person'), { authoredBy: '222' })
    expect(c.result).toBe('conflict')
    expect(c.conflict).toMatchObject({ factId: dm.factId, object: "chloe's room", authoredBy: '111' })
    const [row] = await db.select().from(facts).where(eq(facts.id, c.factId!))
    expect(row).toMatchObject({ isCurrent: false, conflictsWithFactId: dm.factId, objectValue: 'the cave', authoredBy: '222' })
    expect((await put(db, P('zosia', 'stays_in', 'The Cave', 'person'), { authoredBy: '222' })).factId).toBe(c.factId) // a repeat is the same conflict
    expect(await ask(db, 'where is zosia staying?')).toEqual(["zosia stays in: chloe's room"]) // the trusted value stands
    // a system (reflect) fact is never correctable, not even by its subject or the owner
    await put(db, P('zosia', 'profile', 'a guest', 'person'), { trustLevel: 'system', neverSecret: true })
    expect((await put(db, P('zosia', 'profile', 'no', 'person'), { authoredBy: '111', authorIsOwner: true })).result).toBe('conflict')
  })

  it('the name-derived possessor edge is a default, not a statement: a stated owner replaces it (any lane)', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 111, 'Chloe')
    await ensureRegistered(db, GROUP, 222, 'Marco')
    await ensureRegistered(db, GROUP, 333, 'Ryan')
    // Untrusted group text mints "marco's room —belongs_to→ marco" (system, no author)…
    await put(db, P("marco's room", 'has', 'the router', 'place'))
    const [edge] = await db.select().from(facts).where(and(eq(facts.groupId, GROUP), eq(facts.predicate, 'belongs_to')))
    expect(edge).toMatchObject({ trustLevel: 'system', authoredBy: null, isCurrent: true })
    // …and a housemate's plain statement of who owns it now supersedes it — not a permanent conflict.
    const r = await put(db, P("marco's room", 'belongs_to', 'chloe', 'place'), { trustLevel: 'untrusted', authoredBy: '111' })
    expect(r.result).toBe('update')
    const [closed] = await db.select().from(facts).where(eq(facts.id, edge.id))
    expect(closed.isCurrent).toBe(false)
    // A STATED owner is an ordinary fact again: someone else's lower-trust contradiction is a conflict.
    await put(db, P('the shed', 'belongs_to', 'marco'), { trustLevel: 'trusted', authoredBy: '222' })
    expect((await put(db, P('the shed', 'belongs_to', 'chloe'), { authoredBy: '333' })).result).toBe('conflict')
  })

  it('a refused REMOVAL is a conflict too — the value stays', async () => {
    const db = await fresh()
    await put(db, P('the house', 'has_guest', 'marta'), { trustLevel: 'trusted', authoredBy: null })
    expect((await put(db, { ...P('the house', 'has_guest', 'marta'), removes: true }, { authoredBy: null })).result).toBe('conflict')
    expect(await ask(db, 'who is staying at the house?')).toEqual(['house has guest: marta'])
  })
})

describe('tagging by resolved id (F15) + consolidation by author (F9)', () => {
  it('a note about "chloe" is filed under the "chloe smith" node it resolved to', async () => {
    const db = await fresh()
    await upsertMember(db, GROUP, '11', 'Chloe Smith', 'member')
    const person = await ensureSpeakerEntity(db, GROUP, '11', 'Chloe Smith')
    const r = await put(db, P('chloe', 'is_away', 'this weekend', 'person'))
    expect(r.subjectEntityId).toBe(person)
    const id = await captureMemory({ groupId: GROUP, content: 'Chloe is away this weekend', memoryType: 'statement', authoredBy: null, trustLevel: 'untrusted' }, { db, embed: async (t) => embedSync(t) })
    await tagMemoryAboutPerson(db, GROUP, id, r.subjectEntityId)
    const [note] = await db.select({ about: memoryItems.aboutEntityId }).from(memoryItems).where(eq(memoryItems.id, id))
    expect(note.about).toBe(person)
  })

  it('the same line from two housemates is two notes, each attributed to its author', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 1, 'Marco')
    await ensureRegistered(db, GROUP, 2, 'Chloe')
    const deps = { db, embed: async (t: string) => embedSync(t) }
    const cap = (by: string, at: string) =>
      withSimulatedTime(new Date(at), () => captureMemory({ groupId: GROUP, content: "I'm away this weekend", memoryType: 'statement', authoredBy: by, trustLevel: 'untrusted' }, deps))
    const a = await cap('1', '2026-09-01T10:00:00Z')
    const b = await cap('2', '2026-09-01T10:05:00Z')
    expect(b).not.toBe(a)
    // the same person restating it within the window still consolidates …
    expect(await cap('2', '2026-09-01T12:00:00Z')).toBe(b)
    // … but weeks later it is a new statement, dated then
    const c = await cap('2', '2026-09-20T10:00:00Z')
    expect(c).not.toBe(b)
    const rows = await db.select({ id: memoryItems.id, by: memoryItems.authoredBy, at: memoryItems.createdAt }).from(memoryItems).where(eq(memoryItems.groupId, GROUP))
    expect(rows.find((r) => r.id === c)?.at.toISOString()).toBe('2026-09-20T10:00:00.000Z')
    expect(rows.map((r) => r.by).sort()).toEqual(['1', '2', '2'])
  })
})

describe('reconcileFact (the simple API) mirrors the detail', () => {
  it('returns the result string', async () => {
    const db = await fresh()
    expect(await reconcileFact(db, { groupId: GROUP, fact: P('bins', 'go_out', 'friday'), authoredBy: null, trustLevel: 'untrusted' })).toBe('add')
    const [row] = await db.select({ p: facts.predicate }).from(facts).where(eq(facts.groupId, GROUP))
    expect(row.p).toBe('collection_day')
  })
})
