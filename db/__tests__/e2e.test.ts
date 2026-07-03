import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { startPgHarness, dockerAvailable, type PgHarness } from './pg-harness'
import { entities } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
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

  it('dashboard grant is live on the real roster (revoke takes effect immediately)', async () => {
    await upsertMember(h.db, GROUP, '900', 'Tom', 'member')
    expect(await setDashboardAccess(h.db, '900', true)).toBe(true)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(true)
    await setDashboardAccess(h.db, '900', false)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(false)
  })
})
