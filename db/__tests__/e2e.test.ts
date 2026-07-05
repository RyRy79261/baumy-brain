import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { startPgHarness, dockerAvailable, type PgHarness } from './pg-harness'
import { entities } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { resolveSeedEntities, connectedEdges, gatherGraphContext } from '@/lib/memory/graph'
import { findMemoryToForget, forgetMemory } from '@/lib/memory/forget'
import { createReminder, claimReminder, markSent, releaseReminder } from '@/lib/reminders/store'
import { loadResponsePolicy, setGlobalEnabled } from '@/lib/policy'
import { setDashboardAccess, upsertMember, loadRoster } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'

// Secure-value capture needs the app-side key.
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')
const embed = async (t: string) => embedSync(t)
const GROUP = '-100e2e'

// Runs against a REAL pgvector Postgres when Docker is available (locally + CI);
// skips cleanly otherwise so the rest of the suite still runs.
const suite = dockerAvailable() ? describe : describe.skip

suite('E2E — real pgvector Postgres, real migrations, real SQL', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = await startPgHarness()
    await ensureRegistered(h.db, GROUP, null)
  }, 180_000)

  afterAll(async () => {
    await h?.stop()
  })

  it('every real migration applied: embedding is vector(512) + both HNSW indexes exist', async () => {
    const dim = await h.pool.query(
      "SELECT format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid = 'baumy_memory_embeddings'::regclass AND attname = 'embedding'",
    )
    expect(dim.rows[0].t).toBe('vector(512)')
    const idx = await h.pool.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname LIKE '%hnsw%'")
    expect(idx.rows[0].n).toBe(2)
    // memory-v2 columns exist (migrations 0006 content_tsv, 0007 member_id, 0008 about_entity_id)
    const cols = await h.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('baumy_entities','baumy_memory_items') AND column_name IN ('member_id','about_entity_id','content_tsv')",
    )
    expect(cols.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual(['about_entity_id', 'content_tsv', 'member_id'])
  })

  it('memory capture → recall (real embeddings + real pgvector cosine)', async () => {
    await captureMemory(
      { groupId: GROUP, content: 'rent is due friday', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    await captureMemory(
      { groupId: GROUP, content: 'we are out of oat milk', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    const res = await retrieve('when is the rent due', { groupId: GROUP, floor: 0 }, { db: h.db, embed })
    expect(res[0]?.content).toBe('rent is due friday')
  })

  it('hybrid recall: an exact rare term surfaces via the lexical (tsvector) arm', async () => {
    // content_tsv is a generated column + GIN index (migration 0006).
    const col = await h.pool.query(
      "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='baumy_memory_items' AND column_name='content_tsv'",
    )
    expect(col.rows[0].n).toBe(1)

    await captureMemory(
      { groupId: GROUP, content: 'the tortilla press lives in the pantry', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    // A high floor would drop weak vector matches; the exact term 'tortilla' still
    // wins because the lexical arm bypasses the floor when the words actually match.
    const res = await retrieve('where is the tortilla press', { groupId: GROUP, floor: 0.9 }, { db: h.db, embed })
    expect(res.some((r) => r.content.includes('tortilla press'))).toBe(true)
  })

  it('secure value stored encrypted (real crypto + real column), never plaintext', async () => {
    await captureMemory(
      { groupId: GROUP, content: 'the wifi password is hunter2-Berlin', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    const res = await retrieve('what is the wifi password', { groupId: GROUP, floor: 0 }, { db: h.db, embed })
    const hit = res.find((r) => r.isSecure)
    expect(hit).toBeTruthy()
    expect(hit!.content).not.toContain('hunter2')
    expect(hit!.contentEncrypted).toBeTruthy()
  })

  it('fact reconcile is trust-gated on the real schema (memory-poisoning defense)', async () => {
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'landlord', predicate: 'phone', object: '0300' }, authoredBy: null, trustLevel: 'trusted' })
    // a lower-trust (planted) contradiction is rejected, not applied
    expect(
      await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'landlord', predicate: 'phone', object: '0666' }, authoredBy: null, trustLevel: 'untrusted' }),
    ).toBe('rejected')
    const hits = await currentFactsForQuery(h.db, GROUP, 'landlord phone?')
    expect(hits[0]?.content).toContain('0300')
  })

  it('fact lineage: origin note + cross-person progression on the real migration (0009)', async () => {
    await upsertMember(h.db, GROUP, '810', 'Ryan', 'member')
    await upsertMember(h.db, GROUP, '820', 'Marco', 'member')
    const memId = await captureMemory(
      { groupId: GROUP, content: 'zuzka is coming today', memoryType: 'fact', authoredBy: '810', trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    // Ryan: "coming today"; Marco: "arrived" — different predicate → an ADD deriving from the prior fact.
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'zuzka-guest', subjectKind: 'person', predicate: 'arriving', object: 'today' }, authoredBy: '810', trustLevel: 'untrusted', memoryItemId: memId })
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'zuzka-guest', subjectKind: 'person', predicate: 'status', object: 'arrived' }, authoredBy: '820', trustLevel: 'untrusted' })
    // real FKs (source_memory_item_id + derived_from_fact_id) resolved on real Postgres
    const src = await h.pool.query("SELECT source_memory_item_id FROM baumy_facts WHERE predicate = 'arriving' AND group_id = $1", [GROUP])
    expect(src.rows[0].source_memory_item_id).toBe(memId)
    const hits = await currentFactsForQuery(h.db, GROUP, 'has zuzka-guest arrived?')
    const arrived = hits.find((r) => r.content.includes('arrived'))
    expect(arrived?.authoredBy).toBe('820') // Marco stated it
    expect(arrived?.priorContent).toContain('arriving') // ...following Ryan's "coming today"
    expect(arrived?.priorAuthoredBy).toBe('810')
  })

  it('graph traversal: a multi-hop cross-subject walk on the real recursive CTE', async () => {
    // marlowe —sibling of→ perrin —owns→ the loft   (a 2-hop chain across three subjects)
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'marlowe', subjectKind: 'person', predicate: 'sibling_of', object: 'perrin', objectKind: 'person' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'perrin', subjectKind: 'person', predicate: 'owns', object: 'the loft', objectKind: 'place' }, authoredBy: null, trustLevel: 'untrusted' })
    const seeds = await resolveSeedEntities(h.db, GROUP, 'where is marlowe staying')
    const rel = (await connectedEdges(h.db, GROUP, seeds, { maxHops: 2 })).map((e) => `${e.subject} ${e.predicate} ${e.object}`)
    expect(rel).toContain('marlowe sibling of perrin') // 1 hop
    expect(rel).toContain('perrin owns loft') // 2 hops — reached THROUGH perrin (real WITH RECURSIVE)
    const conns = (await gatherGraphContext(h.db, GROUP, 'where is marlowe staying')).filter((i) => i.memoryType === 'connection')
    expect(conns.length).toBeGreaterThanOrEqual(2)
  })

  it('entity resolution: surface variants merge; read-side fuzzy recalls (real pg_trgm)', async () => {
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'the kitchen sink', predicate: 'status', object: 'leaking' }, authoredBy: null, trustLevel: 'untrusted' })
    // "the sink" trigram-merges onto the same entity → supersede, not a fork.
    expect(
      await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'the sink', predicate: 'status', object: 'fixed' }, authoredBy: null, trustLevel: 'untrusted' }),
    ).toBe('update')
    // read-side fuzzy: singular query recalls the fact under a merged/varied surface.
    const hits = await currentFactsForQuery(h.db, GROUP, 'did we fix the sinks yet')
    expect(hits.some((r) => r.content.includes('fixed'))).toBe(true)
  })

  it('member bridge: a person entity links to its housemate row (real migration 0007)', async () => {
    const col = await h.pool.query(
      "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='baumy_entities' AND column_name='member_id'",
    )
    expect(col.rows[0].n).toBe(1)
    await upsertMember(h.db, GROUP, '955', 'Zenobia', 'member')
    await reconcileFact(h.db, {
      groupId: GROUP,
      fact: { subject: 'zenobia', subjectKind: 'person', predicate: 'brings', object: 'snacks' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    const [e] = await h.db
      .select({ m: entities.memberId })
      .from(entities)
      .where(and(eq(entities.groupId, GROUP), eq(entities.canonicalName, 'zenobia')))
    expect(e.m).toBe('955')
  })

  it('reminder: atomic claim (exactly-once) + release re-arms on failure', async () => {
    const id = await createReminder(h.db, { groupId: GROUP, deliverChatId: GROUP, content: 'pay rent', fireAt: new Date(Date.now() - 1000), createdBy: null })
    expect(await claimReminder(h.db, id)).toBe(true)
    expect(await claimReminder(h.db, id)).toBe(false) // concurrent loser
    await releaseReminder(h.db, id) // simulate a send failure
    expect(await claimReminder(h.db, id)).toBe(true) // re-claimable, so it retries
    await markSent(h.db, id)
    expect(await claimReminder(h.db, id)).toBe(false)
  })

  it('response-policy kill-switch persists via the singleton jsonb (upsert)', async () => {
    expect((await loadResponsePolicy(h.db)).global_enabled).toBe(true)
    await setGlobalEnabled(h.db, false)
    expect((await loadResponsePolicy(h.db)).global_enabled).toBe(false)
    await setGlobalEnabled(h.db, true)
  })

  it('forget on request: purge redacts the fact + surgically scrubs the message (real SQL)', async () => {
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'guest-bob', subjectKind: 'person', predicate: 'full_name', object: 'Robert Tables' }, authoredBy: null, trustLevel: 'trusted' })
    await captureMemory(
      { groupId: GROUP, content: 'Robert Tables is crashing in the cave this week', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    // exact ILIKE match on the value string runs on the real schema
    const m = await findMemoryToForget(h.db, GROUP, { values: ['Robert Tables'], subject: '', attribute: '' })
    expect(m.factIds.length).toBeGreaterThanOrEqual(1)
    expect(m.facts.some((c) => c.label.includes('Robert Tables'))).toBe(true)
    expect(m.scrubValues).toContain('Robert Tables')

    const res = await forgetMemory(h.db, GROUP, { factIds: m.factIds, scrubValues: m.scrubValues, noteIds: m.noteIds, aliasHits: m.aliasHits, mode: 'purge' })
    expect(res.messagesScrubbed).toBeGreaterThanOrEqual(1)
    // fact gone from recall; a fresh search finds nothing left to forget
    expect(await currentFactsForQuery(h.db, GROUP, 'what is guest-bob full name')).toHaveLength(0)
    expect((await findMemoryToForget(h.db, GROUP, { values: ['Robert Tables'], subject: '', attribute: '' })).facts).toHaveLength(0)
    // the source message SURVIVED (active) with only the name scrubbed
    const note = await h.pool.query("SELECT content, is_active FROM baumy_memory_items WHERE content LIKE '%crashing in the cave%'")
    expect(note.rows[0].is_active).toBe(true)
    expect(note.rows[0].content).not.toContain('Robert Tables')
  })

  it('dashboard grant is live on the real roster (revoke takes effect immediately)', async () => {
    await upsertMember(h.db, GROUP, '900', 'Tom', 'member')
    expect(await setDashboardAccess(h.db, '900', true)).toBe(true)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(true)
    await setDashboardAccess(h.db, '900', false)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(false)
  })
})
