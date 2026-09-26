// AUDIT REPRO (fact graph / entity resolution / retrieval). Each test asserts the CURRENT
// (buggy) behaviour — a passing test == the finding is confirmed. Offline: PGlite + embedSync.
import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { entities, facts, memoryItems } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { embedSync } from '@/lib/ai/embed'
import { reconcileFact, currentFactsForQuery, tagMemoryAboutPerson, type ExtractedFact } from '@/lib/memory/facts'
import { entityTimeline } from '@/lib/memory/graph'
import { forgetMemory } from '@/lib/memory/forget'
import { retrieve } from '@/lib/memory/retrieve'
import { withSimulatedTime } from '@/lib/core/clock'

const GROUP = '-100auditmem'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
type Db = Awaited<ReturnType<typeof makeTestDb>>
type Trust = 'system' | 'trusted' | 'untrusted' | 'quarantined'

let tick = 0
const base = Date.parse('2026-09-01T10:00:00Z')
// Each write gets a strictly later recorded_at (a real chat is seconds/minutes apart).
async function put(db: Db, fact: ExtractedFact, trustLevel: Trust = 'untrusted', authoredBy: string | null = null) {
  tick += 1
  return withSimulatedTime(new Date(base + tick * 60_000), () => reconcileFact(db, { groupId: GROUP, fact, authoredBy, trustLevel }))
}
const P = (subject: string, predicate: string, object: string, subjectKind?: ExtractedFact['subjectKind'], objectKind?: ExtractedFact['objectKind']): ExtractedFact => ({ subject, predicate, object, subjectKind, objectKind })

async function fresh() {
  const db = await makeTestDb()
  await ensureRegistered(db, GROUP, null)
  return db
}

describe('C11 — one current value per (subject, predicate): multi-valued relations overwrite', () => {
  it('a second house guest supersedes the first', async () => {
    const db = await fresh()
    expect(await put(db, P('house', 'has_guest', 'marta'))).toBe('add')
    expect(await put(db, P('house', 'has_guest', 'zuzka'))).toBe('update') // NOT an add
    const hits = await currentFactsForQuery(db, GROUP, 'who is staying at the house this weekend?')
    expect(hits.some((h) => h.content.includes('zuzka'))).toBe(true)
    expect(hits.some((h) => h.content.includes('marta'))).toBe(false) // Marta silently gone
  })
  it('a person with two likes/allergies keeps only the last one', async () => {
    const db = await fresh()
    await put(db, P('marco', 'allergic_to', 'peanuts', 'person'))
    expect(await put(db, P('marco', 'allergic_to', 'shellfish', 'person'))).toBe('update')
    const hits = await currentFactsForQuery(db, GROUP, 'what is marco allergic to?')
    expect(hits.map((h) => h.content)).toEqual(['marco allergic to: shellfish'])
  })
})

describe('C12 — free-text predicates never normalised: a correction does not supersede', () => {
  it('arrives_on vs arrival_date are both current and contradict each other', async () => {
    const db = await fresh()
    await put(db, P('zuzka', 'arrives_on', 'friday', 'person'))
    expect(await put(db, P('zuzka', 'arrival_date', 'saturday', 'person'))).toBe('add') // no supersede
    const hits = (await currentFactsForQuery(db, GROUP, 'when does zuzka arrive?')).map((h) => h.content)
    expect(hits).toContain('zuzka arrives on: friday')
    expect(hits).toContain('zuzka arrival date: saturday')
  })
})

describe('C13 — trust gate blocks the SAME person correcting their own DM fact from the group', () => {
  it('Charli DMs a fact (trusted) then corrects it in the group (untrusted) → rejected silently', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 111, 'Charli')
    expect(await put(db, P('zuzka', 'staying_in', "charli's room", 'person'), 'trusted', '111')).toBe('add')
    expect(await put(db, P('zuzka', 'staying_in', 'the cave', 'person'), 'untrusted', '111')).toBe('rejected')
    const hits = (await currentFactsForQuery(db, GROUP, 'where is zuzka staying?')).map((h) => h.content)
    expect(hits).toEqual(["zuzka staying in: charli's room"]) // stale value keeps answering
  })
})

describe('C14 — substring subject matching: false positives, hub crowding, full-name misses', () => {
  it('a short entity name matches inside unrelated words ("al" in "all", "bathroom" hits nothing about Al)', async () => {
    const db = await fresh()
    await put(db, P('al', 'owes_rent', '£200', 'person'))
    const hits = (await currentFactsForQuery(db, GROUP, 'is the bathroom tap fixed at all?')).map((h) => h.content)
    expect(hits).toContain('al owes rent: £200') // leaked into an unrelated answer's grounding
  })
  it('the "house" hub entity (every "we/our" fact) crowds the named subject out of the 5-slot limit', async () => {
    const db = await fresh()
    await put(db, P('zuzka', 'staying_in', 'the cave', 'person'))
    for (const [p, o] of [['bin_day', 'friday'], ['wifi_provider', 'virgin'], ['needs', 'milk'], ['cleaner_day', 'tuesday'], ['landlord', 'dave'], ['boiler_service', 'october']])
      await put(db, P('house', p, o))
    const hits = (await currentFactsForQuery(db, GROUP, 'is zuzka staying at our house this weekend?')).map((h) => h.content)
    expect(hits).toHaveLength(5)
    expect(hits.some((h) => h.startsWith('zuzka'))).toBe(false) // the ONE relevant fact is dropped
  })
  it('a fact filed under the speaker FULL display name is not found by first name', async () => {
    const db = await fresh()
    // extract resolves "I'm away this weekend" (speaker = "Charli Smith") to subject "charli smith"
    await put(db, P('Charli Smith', 'away', 'this weekend', 'person'))
    const hits = await currentFactsForQuery(db, GROUP, 'is charli around this weekend?')
    expect(hits).toHaveLength(0)
  })
  it('object-side questions ("who is in the cave") find no direct fact', async () => {
    const db = await fresh()
    await put(db, P('zuzka', 'staying_in', 'the cave', 'person', 'place'))
    const hits = (await currentFactsForQuery(db, GROUP, "who's staying in the cave?")).map((h) => h.content)
    expect(hits.some((h) => h.startsWith('zuzka'))).toBe(false)
  })
})

describe('NEW — write-side trigram merge folds a possessive thing into its owner (precision-first violated)', () => {
  it('"charli\'s bike" (kind thing) resolves to the PERSON charli and clobbers her location', async () => {
    const db = await fresh()
    await put(db, P('charli', 'location', 'barcelona', 'person'))
    // thing-kind guard is lenient: an incoming 'thing' may merge into any kind
    expect(await put(db, P("charli's bike", 'location', 'the shed'))).toBe('update')
    const ents = await db.select({ name: entities.canonicalName, aliases: entities.aliases }).from(entities).where(eq(entities.groupId, GROUP))
    expect(ents).toHaveLength(1)
    expect(ents[0].aliases).toContain("charli's bike")
    const hits = (await currentFactsForQuery(db, GROUP, 'where is charli?')).map((h) => h.content)
    expect(hits).toEqual(['charli location: the shed']) // Charli is "in the shed"
  })
  it('a generic "room" place absorbs every "X\'s room", so rooms supersede each other', async () => {
    const db = await fresh()
    await put(db, P('the room', 'has', 'a broken blind', 'place'))
    await put(db, P("marco's room", 'status', 'free', 'place'))
    expect(await put(db, P("charli's room", 'status', 'occupied', 'place'))).toBe('update')
    const n = await db.select({ id: entities.id }).from(entities).where(eq(entities.groupId, GROUP))
    expect(n).toHaveLength(1)
  })
})

describe('NEW — lineage: derived_from = "last thing said about the subject" → false "follows from"', () => {
  it('an unrelated prior fact is presented as the parent of a new one', async () => {
    const db = await fresh()
    await put(db, P('zuzka', 'sibling_of', 'charl', 'person'))
    await put(db, P('zuzka', 'staying_in', 'the cave', 'person'))
    const [hit] = (await currentFactsForQuery(db, GROUP, 'where is zuzka staying')).filter((h) => h.content.includes('staying'))
    expect(hit.priorContent).toBe('zuzka sibling of: charl') // rendered "(follows from — zuzka sibling of: charl)"
  })
  it('a SOFT-FORGOTTEN fact resurfaces verbatim as the lineage parent of the next fact', async () => {
    const db = await fresh()
    await put(db, P('zuzka', 'staying_in', "marco's room", 'person'))
    const [row] = await db.select({ id: facts.id }).from(facts).where(eq(facts.groupId, GROUP))
    await forgetMemory(db, GROUP, { factIds: [row.id], scrubValues: [], noteIds: [], aliasHits: [], mode: 'soft' })
    await put(db, P('zuzka', 'staying_in', 'the cave', 'person'))
    const hits = await currentFactsForQuery(db, GROUP, 'where is zuzka staying')
    expect(hits[0].priorContent).toBe("zuzka staying in: marco's room") // forgotten value back in grounding
  })
})

describe('NEW — entityTimeline returns the OLDEST 8 entries, not the latest progression', () => {
  it('the newest fact about a busy subject is missing from its timeline', async () => {
    const db = await fresh()
    for (let i = 1; i <= 10; i++) await put(db, P('zuzka', `note_${i}`, `v${i}`, 'person'))
    const [ent] = await db.select({ id: entities.id }).from(entities).where(eq(entities.canonicalName, 'zuzka'))
    const tl = (await entityTimeline(db, GROUP, ent.id)).map((t) => t.content)
    expect(tl).toHaveLength(8)
    expect(tl.some((c) => c.includes('v10'))).toBe(false)
    expect(tl[0]).toContain('v1')
  })
})

describe('NEW — 0.97 consolidation ignores author: identical first-person lines from two people collapse', () => {
  it('Charli\'s "I\'m away this weekend" is folded onto Marco\'s note and re-tagged about Charli', async () => {
    const db = await fresh()
    await ensureRegistered(db, GROUP, 1, 'Marco')
    await ensureRegistered(db, GROUP, 2, 'Charli')
    const deps = { db, embed: async (t: string) => embedSync(t) }
    const a = await captureMemory({ groupId: GROUP, content: "I'm away this weekend", memoryType: 'fact', authoredBy: '1', trustLevel: 'untrusted' }, deps)
    const b = await captureMemory({ groupId: GROUP, content: "I'm away this weekend", memoryType: 'fact', authoredBy: '2', trustLevel: 'untrusted' }, deps)
    expect(b).toBe(a)
    const notes = await db.select({ by: memoryItems.authoredBy }).from(memoryItems).where(eq(memoryItems.groupId, GROUP))
    expect(notes).toEqual([{ by: '1' }]) // only Marco's; Charli's statement has no evidence row
    // capture then tags the (shared) note "about" Charli — Marco's note is now filed under Charli
    await put(db, P('charli', 'away', 'this weekend', 'person'), 'untrusted', '2')
    await tagMemoryAboutPerson(db, GROUP, b, [P('charli', 'away', 'this weekend', 'person')])
    const [ch] = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'charli')))
    const [note] = await db.select({ about: memoryItems.aboutEntityId, by: memoryItems.authoredBy }).from(memoryItems).where(eq(memoryItems.id, a))
    expect(note).toEqual({ about: ch.id, by: '1' })
  })
})

describe('NEW — tagMemoryAboutPerson exact-matches canonical name, so an alias-merged subject is never tagged', () => {
  it('a note about "Charli" is not filed under the "charli smith" entity', async () => {
    const db = await fresh()
    await put(db, P('Charli Smith', 'room', 'upstairs', 'person'))
    await put(db, P('charli', 'away', 'this weekend', 'person')) // merges via trigram (alias)
    const deps = { db, embed: async (t: string) => embedSync(t) }
    const id = await captureMemory({ groupId: GROUP, content: 'Charli is away this weekend', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, deps)
    await tagMemoryAboutPerson(db, GROUP, id, [P('charli', 'away', 'this weekend', 'person')])
    const [note] = await db.select({ about: memoryItems.aboutEntityId }).from(memoryItems).where(eq(memoryItems.id, id))
    expect(note.about).toBeNull()
  })
})

describe('NEW — lexical arm uses websearch_to_tsquery (AND of every term): natural questions never lexically match', () => {
  it('a note mentioning Zuzka is found by "zuzka" but not by a natural question about her', async () => {
    const db = await fresh()
    const deps = { db, embed: async (t: string) => embedSync(t) }
    await captureMemory({ groupId: GROUP, content: 'Zuzka is staying in my room this weekend', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' }, deps)
    // isolate the LEXICAL arm: query vectors orthogonal-ish to the note (semantic floor excludes it)
    const junk = { db, embed: async () => embedSync('completely unrelated vocabulary xyzzy plugh') }
    const bare = await retrieve('zuzka', { groupId: GROUP, k: 8, floor: 0.99 }, junk)
    const natural = await retrieve('when does zuzka arrive?', { groupId: GROUP, k: 8, floor: 0.99 }, junk)
    expect(bare).toHaveLength(1)
    expect(natural).toHaveLength(0) // "arrive" absent from the note → whole lexical AND fails
  })
})
