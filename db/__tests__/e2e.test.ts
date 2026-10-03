import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { startPgHarness, dockerAvailable, type PgHarness } from './pg-harness'
import { auditLog, entities, facts, memoryItems, reminders } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { reconcileFact, reconcileFactDetailed, currentFactsForQuery, upcomingDatedFacts, eventGroupFacts, ensureSpeakerEntity } from '@/lib/memory/facts'
import { runHygieneSweep } from '@/lib/memory/hygiene'
import { resolveSeedEntities, connectedEdges, gatherGraphContext } from '@/lib/memory/graph'
import { findMemoryToForget, forgetMemory, redactValues } from '@/lib/memory/forget'
import { appendInbound, recentTurns, scrubWindow, purgeWindow, linkProduced, withholdProducing, EXPIRED_WINDOW_TEXT } from '@/lib/turn/window'
import { createReminder, claimReminder, markSent, releaseReminder, scheduleNextOccurrence, loadSeriesRow, repairRecurringSeries, orphanedEventReminders, reminderDestination } from '@/lib/reminders/store'
import { lookupEdit, withdrawForEdit, settleEditedFacts } from '@/lib/turn/edit'
import { addListItems, checkOffItems, currentList } from '@/lib/lists/store'
import { runConsolidationSweep } from '@/lib/inngest/functions/consolidation'
import { loadResponsePolicy, setGlobalEnabled, addMutedTopic, removeMutedTopic } from '@/lib/policy'
import { setDashboardAccess, upsertMember, loadRoster } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { withSimulatedTime } from '@/lib/core/clock'
import { __setDbOverride } from '@/db/client'
import { POST as kitchenAdd } from '@/app/api/kitchen/shopping/add/route'
import { GET as kitchenList } from '@/app/api/kitchen/shopping/route'

// Secure-value capture needs the app-side key.
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')

// The heads-up LINE is written by the model (lib/ai/nudge.ts) — mocked, like every other LLM call
// in the suite, so this stays offline. What the e2e proves is the REAL SQL underneath: the dated-
// fact query, the grouping, the dedupe and the cancel, against real Postgres.
vi.mock('@/lib/ai/nudge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/nudge')>()
  return { ...actual, writeHeadsUp: async (facts: { subject: string }[]) => `heads-up about ${facts[0]?.subject}` }
})
const { runEventSurfacingScan } = await import('@/lib/inngest/functions/surfacing')
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
    // a lower-trust (planted) contradiction is not applied — kept as a non-current conflict row (spec §7, F5)
    expect(
      await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'landlord', predicate: 'phone', object: '0666' }, authoredBy: null, trustLevel: 'untrusted' }),
    ).toBe('conflict')
    const hits = await currentFactsForQuery(h.db, GROUP, 'landlord phone?')
    expect(hits.map((x) => x.content)).toEqual([expect.stringContaining('0300')])
    const c = await h.pool.query("SELECT is_current, conflicts_with_fact_id FROM baumy_facts WHERE group_id = $1 AND object_value = '0666'", [GROUP])
    expect(c.rows[0].is_current).toBe(false)
    expect(c.rows[0].conflicts_with_fact_id).toBeTruthy()
  })

  it('fact lineage: origin note + a correction that shows what it replaced, on the real migration (0009)', async () => {
    await upsertMember(h.db, GROUP, '810', 'Ryan', 'member')
    await upsertMember(h.db, GROUP, '820', 'Marco', 'member')
    const memId = await captureMemory(
      { groupId: GROUP, content: 'zosia is coming today', memoryType: 'fact', authoredBy: '810', trustLevel: 'untrusted' },
      { db: h.db, embed },
    )
    // Ryan: "arriving today"; Marco corrects it under a SYNONYM predicate → it supersedes (F3), and the
    // lineage parent is the value it replaced (F8 — never an unrelated earlier fact).
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'zosia-guest', subjectKind: 'person', predicate: 'arriving', object: 'today' }, authoredBy: '810', trustLevel: 'untrusted', memoryItemId: memId })
    await reconcileFact(h.db, { groupId: GROUP, fact: { subject: 'zosia-guest', subjectKind: 'person', predicate: 'arrival_date', object: 'tomorrow' }, authoredBy: '820', trustLevel: 'untrusted' })
    // real FKs (source_memory_item_id + derived_from_fact_id) resolved on real Postgres
    const src = await h.pool.query("SELECT source_memory_item_id FROM baumy_facts WHERE predicate = 'arrives_on' AND object_value = 'today' AND group_id = $1", [GROUP])
    expect(src.rows[0].source_memory_item_id).toBe(memId)
    const hits = await currentFactsForQuery(h.db, GROUP, 'when does zosia-guest arrive?')
    const arrival = hits.find((r) => r.content.includes('arrives on'))
    expect(arrival?.content).toContain('tomorrow')
    expect(arrival?.authoredBy).toBe('820') // Marco stated it
    expect(arrival?.priorContent).toContain('today') // ...replacing Ryan's "today"
    expect(arrival?.priorAuthoredBy).toBe('810')
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

  it('policy field patches + their audit row run as one statement on real Postgres (PR #13 review)', async () => {
    await addMutedTopic(h.db, 'Politics', { actor: '7', action: 'policy.muted_topic.add', metadata: { topic: 'Politics' } })
    await addMutedTopic(h.db, 'politics')
    await removeMutedTopic(h.db, 'nothing-there')
    expect((await loadResponsePolicy(h.db)).muted_topics).toEqual(['politics'])
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, 'policy.muted_topic.add'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actorMemberId: '7', metadata: { topic: 'Politics' } })
    await removeMutedTopic(h.db, 'politics')
    expect((await loadResponsePolicy(h.db)).muted_topics).toEqual([])
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

  it('shopping list: partial-unique open dedup + check-off then re-add on real Postgres (migration 0010)', async () => {
    // The partial predicate is the one thing PGlite can't be trusted to reproduce — assert it
    // survived to real Postgres, then exercise the behavior it guards.
    const idx = await h.pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'baumy_list_items_open_uq'")
    expect(idx.rows[0].indexdef).toContain('WHERE') // it's a PARTIAL unique index
    expect(idx.rows[0].indexdef).toContain('checked_at')

    await addListItems(h.db, { groupId: GROUP, items: ['oat milk', 'bin bags'], addedBy: null })
    // re-adding an OPEN item is a no-op — the partial-unique index (real PG) + onConflictDoNothing
    const dup = await addListItems(h.db, { groupId: GROUP, items: ['oat milk'], addedBy: null })
    expect(dup.added).toEqual([])
    expect(dup.already).toEqual(['oat milk'])
    // check it off → it leaves the open predicate → the same item can be re-added as a fresh row
    await checkOffItems(h.db, { groupId: GROUP, items: ['oat milk'], checkedBy: null })
    const re = await addListItems(h.db, { groupId: GROUP, items: ['oat milk'], addedBy: null })
    expect(re.added).toEqual(['oat milk'])
    expect((await currentList(h.db, GROUP)).map((r) => r.item).sort()).toEqual(['bin bags', 'oat milk'])
  })

  it('kitchen API: concurrent adds of the same item leave ONE open row on real Postgres (the partial-unique index holds)', async () => {
    const KITCHEN = '-100e2eKitchen'
    vi.stubEnv('KITCHEN_API_TOKEN', 'e2e-kitchen-token-0123456789abcdef')
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', KITCHEN) // the pinned scope; the add registers the chat for the FK
    __setDbOverride(h.db)
    try {
      const post = () =>
        kitchenAdd(
          new Request('http://local/api/kitchen/shopping/add', {
            method: 'POST',
            headers: { authorization: 'Bearer e2e-kitchen-token-0123456789abcdef', 'content-type': 'application/json' },
            body: JSON.stringify({ items: ['Oat Milk'] }),
          }),
        )
      const results = await Promise.all([post(), post(), post()])
      expect(results.map((r) => r.status)).toEqual([200, 200, 200])
      const bodies = (await Promise.all(results.map((r) => r.json()))) as { added: string[]; already: string[] }[]
      expect(bodies.flatMap((b) => b.added)).toEqual(['Oat Milk']) // exactly one insert won the race
      // …and every answer names the item: the winner as added, each loser as already there.
      for (const b of bodies) expect([...b.added, ...b.already]).toEqual(['Oat Milk'])
      const list = await kitchenList(new Request('http://local/api/kitchen/shopping', { headers: { authorization: 'Bearer e2e-kitchen-token-0123456789abcdef' } }))
      expect(((await list.json()) as { items: { item: string }[] }).items.map((i) => i.item)).toEqual(['Oat Milk'])
      expect((await currentList(h.db, KITCHEN)).length).toBe(1)
    } finally {
      __setDbOverride(null)
      vi.unstubAllEnvs()
    }
  })

  it('event surfacing: a dated fact schedules event-anchored heads-ups on real Postgres', async () => {
    // event_at is populated at capture; the scan reads it via the real timestamptz comparison.
    const eventAt = new Date(Date.now() + 7.5 * 86_400_000) // inside the 8-day horizon, all 3 stages future
    await reconcileFact(h.db, {
      groupId: GROUP,
      fact: { subject: 'guest-nadia', subjectKind: 'person', predicate: 'arrives_on', object: 'soon' },
      authoredBy: null,
      trustLevel: 'untrusted',
      eventAt,
    })
    const res = await runEventSurfacingScan(h.db, GROUP, new Date(), 'Europe/Berlin')
    expect(res.created).toBeGreaterThanOrEqual(2)
    const rows = await h.pool.query(
      "SELECT anchor_kind, event_fact_id, content FROM baumy_reminders WHERE group_id = $1 AND anchor_kind = 'event_offset'",
      [GROUP],
    )
    expect(rows.rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.rows[0].event_fact_id).toBeTruthy() // anchored to the fact
    expect(String(rows.rows[0].content)).toContain('guest-nadia') // the written line, not a template
    // re-scan is idempotent (no duplicate stages)
    const again = await runEventSurfacingScan(h.db, GROUP, new Date(), 'Europe/Berlin')
    expect(again.created).toBe(0)
  })

  it('consolidation: backfills a missed date against recorded_at + cancels a superseded heads-up (real PG)', async () => {
    const now = new Date()
    // An undated fact whose date lives in the object — the pre-feature / extractor-missed shape.
    await reconcileFact(h.db, {
      groupId: GROUP,
      fact: { subject: 'guest-omar', subjectKind: 'person', predicate: 'arrives_on', object: 'in 6 days' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    const res = await runConsolidationSweep(h.db, GROUP, now, 'Europe/Berlin')
    expect(res.backfilled).toBeGreaterThanOrEqual(1) // event_at resolved against recorded_at
    expect(res.created).toBeGreaterThanOrEqual(1) // heads-ups scheduled for the now-dated event
    const dated = await h.pool.query(
      "SELECT count(*)::int n FROM baumy_facts WHERE group_id = $1 AND is_current = true AND event_at IS NOT NULL",
      [GROUP],
    )
    expect(dated.rows[0].n).toBeGreaterThanOrEqual(1)

    // The plan changes → supersede the arrival; the integrity pass cancels its stale heads-ups.
    await reconcileFact(h.db, {
      groupId: GROUP,
      fact: { subject: 'guest-omar', subjectKind: 'person', predicate: 'arrives_on', object: 'cancelled' },
      authoredBy: null,
      trustLevel: 'untrusted',
    })
    const res2 = await runConsolidationSweep(h.db, GROUP, now, 'Europe/Berlin')
    expect(res2.cancelled).toBeGreaterThanOrEqual(1)
    const cancelled = await h.pool.query(
      "SELECT count(*)::int n FROM baumy_reminders WHERE group_id = $1 AND anchor_kind = 'event_offset' AND status = 'cancelled'",
      [GROUP],
    )
    expect(cancelled.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('dashboard grant is live on the real roster (revoke takes effect immediately)', async () => {
    await upsertMember(h.db, GROUP, '900', 'Tom', 'member')
    expect(await setDashboardAccess(h.db, '900', true)).toBe(true)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(true)
    await setDashboardAccess(h.db, '900', false)
    expect((await loadRoster(h.db)).canAccessDashboard(900)).toBe(false)
  })
  it('conversation window: migrations 0017/0018, redacted append, topic-scoped 48h read, scrub + purge (real SQL)', async () => {
    const cols = await h.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'baumy_messages' AND column_name IN ('text', 'text_redacted', 'seq')")
    expect(cols.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual(['seq', 'text_redacted'])
    const t0 = new Date('2026-09-26T19:00:00Z')
    const base = { groupId: GROUP, chatId: GROUP, authorKind: 'member' as const, authorMemberId: null, authorName: 'Marco', trust: 'untrusted', replyToMessageId: null }
    await appendInbound(h.db, { ...base, messageId: 1, text: 'the wifi password is hunter2', threadId: null, sentAt: t0 })
    await appendInbound(h.db, { ...base, messageId: 2, text: 'call Robert on 0176 5550123', threadId: null, sentAt: new Date(t0.getTime() + 60_000) })
    await appendInbound(h.db, { ...base, messageId: 3, text: 'in the topic', threadId: 44, sentAt: new Date(t0.getTime() + 120_000) })
    await appendInbound(h.db, { ...base, messageId: 4, text: 'long ago', threadId: null, sentAt: new Date(t0.getTime() - 49 * 3_600_000) })
    // an edit (same chat + message_id) upserts
    await appendInbound(h.db, { ...base, messageId: 2, text: 'call Robert on 0176 5550123 tonight', threadId: null, sentAt: new Date(t0.getTime() + 60_000) })
    const general = await recentTurns(h.db, { groupId: GROUP, chatId: GROUP, threadId: null, at: new Date(t0.getTime() + 600_000) })
    expect(general.map((t) => t.text)).toEqual(['[a message containing the wifi password — withheld]', 'call Robert on 0176 5550123 tonight'])
    expect((await recentTurns(h.db, { groupId: GROUP, chatId: GROUP, threadId: 44, at: new Date(t0.getTime() + 600_000) })).map((t) => t.text)).toEqual(['in the topic'])
    const secret = await h.pool.query("SELECT count(*)::int n FROM baumy_messages WHERE text_redacted LIKE '%hunter2%'")
    expect(secret.rows[0].n).toBe(0)
    expect(await scrubWindow(h.db, GROUP, ['0176 5550123'], redactValues)).toBe(1)
    expect(await purgeWindow(h.db, t0)).toBe(1)
    // A forget (soft or purge) withholds the row that PRODUCED a forgotten fact (jsonb membership).
    const fid = '00000000-0000-0000-0000-0000000000e2'
    await linkProduced(h.db, { chatId: GROUP, messageId: 3 }, { factIds: [fid] })
    expect(await withholdProducing(h.db, GROUP, { factIds: [fid], memoryItemIds: [] }, '[forgotten]')).toBe(1)
    const left = await h.pool.query('SELECT text_redacted FROM baumy_messages WHERE group_id = $1 ORDER BY seq', [GROUP])
    expect(left.rows.map((r: { text_redacted: string }) => r.text_redacted)).toEqual([
      '[a message containing the wifi password — withheld]',
      'call Robert on [redacted] tonight',
      '[forgotten]',
    ])
  })

  it('time model: migration 0019 + the "current = live" filter and the recurring-series SQL on real Postgres', async () => {
    const G = '-100e2e-time'
    await ensureRegistered(h.db, G, null)
    const uq = await h.pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'baumy_reminders_previous_uq'")
    expect(uq.rows[0].indexdef).toMatch(/UNIQUE INDEX .* \(previous_reminder_id\)/)

    // An expired stay (March) vs a live one (October): only the live one is current / upcoming / a group.
    const stay = { subject: 'zosia', subjectKind: 'person' as const, predicate: 'staying_in', object: 'the cave', objectKind: 'place' as const }
    await withSimulatedTime(new Date('2026-03-12T18:00:00Z'), () =>
      reconcileFact(h.db, { groupId: G, fact: stay, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-13T23:00:00Z'), validTo: new Date('2026-03-15T22:59:59.999Z') }),
    )
    const now = new Date('2026-09-29T10:00:00Z')
    expect(await withSimulatedTime(now, () => currentFactsForQuery(h.db, G, 'zosia'))).toHaveLength(0)
    const r = await withSimulatedTime(now, () =>
      reconcileFact(h.db, { groupId: G, fact: stay, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-10-02T22:00:00Z'), validTo: new Date('2026-10-04T21:59:59.999Z') }),
    )
    expect(r).toBe('add') // a new occurrence (T6), not a noop
    const live = await withSimulatedTime(now, () => currentFactsForQuery(h.db, G, 'zosia'))
    expect(live.map((f) => f.validTo?.toISOString())).toEqual(['2026-10-04T21:59:59.999Z'])
    const upcoming = await upcomingDatedFacts(h.db, G, now, new Date('2026-10-10T00:00:00Z'))
    expect(upcoming).toHaveLength(1)
    expect(await eventGroupFacts(h.db, upcoming[0].id, 'Europe/Berlin', now)).toHaveLength(1)
    // A heads-up anchored to it is orphaned once the stay is over.
    await createReminder(h.db, { groupId: G, deliverChatId: G, content: 'heads-up', fireAt: new Date('2026-10-02T18:00:00Z'), anchorKind: 'event_offset', eventFactId: upcoming[0].id, createdBy: null })
    expect(await orphanedEventReminders(h.db, G, now)).toHaveLength(0)
    expect(await orphanedEventReminders(h.db, G, new Date('2026-10-05T10:00:00Z'))).toHaveLength(1)

    // Recurring: "create next" is exactly-once on the unique previous_reminder_id; the repair sweep finds nothing to do.
    const id = await createReminder(h.db, { groupId: G, deliverChatId: G, content: 'bins out', fireAt: new Date('2026-10-02T18:00:00Z'), createdBy: null, recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
    await markSent(h.db, id)
    const row = (await loadSeriesRow(h.db, id))!
    const first = await scheduleNextOccurrence(h.db, row, new Date('2026-10-02T18:00:00Z'), 'Europe/Berlin')
    expect(first).toBeTruthy()
    expect(await scheduleNextOccurrence(h.db, row, new Date('2026-10-02T18:00:00Z'), 'Europe/Berlin')).toBeNull()
    expect(await repairRecurringSeries(h.db, new Date('2026-10-03T06:00:00Z'), 'Europe/Berlin')).toBe(0)
    const series = await h.pool.query('SELECT fire_at FROM baumy_reminders WHERE previous_reminder_id = $1', [id])
    expect(series.rows.map((x: { fire_at: Date }) => x.fire_at.toISOString())).toEqual(['2026-10-09T18:00:00.000Z'])
  })

  it('migration 0020: a LEGACY live dated fact (event_at set, valid_to NULL) is closed and stops being current (T2)', async () => {
    const G = '-100e2e-legacy'
    await ensureRegistered(h.db, G, null)
    const stay = { subject: 'zosia', subjectKind: 'person' as const, predicate: 'stays_in', object: "chloe's room", objectKind: 'place' as const }
    const party = { subject: 'marco', subjectKind: 'person' as const, predicate: 'hosts_party', object: 'Sat 14 Mar 21:00' }
    const march = new Date('2026-03-10T10:00:00Z')
    await withSimulatedTime(march, () => reconcileFact(h.db, { groupId: G, fact: stay, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-13T23:00:00Z') }))
    await withSimulatedTime(march, () => reconcileFact(h.db, { groupId: G, fact: party, authoredBy: null, trustLevel: 'untrusted', eventAt: new Date('2026-03-14T20:00:00Z') }))
    // The pre-time-model shape: dated, but valid_to only ever written on close.
    await h.pool.query('UPDATE baumy_facts SET valid_to = NULL WHERE group_id = $1', [G])
    const sept = new Date('2026-09-26T10:00:00Z')
    expect(await withSimulatedTime(sept, () => currentFactsForQuery(h.db, G, 'zosia staying'))).toHaveLength(1) // the bug

    await h.pool.query(readFileSync(join(process.cwd(), 'db/migrations/0020_close_legacy_dated_facts.sql'), 'utf8'))
    const rows = await h.pool.query('SELECT predicate, valid_to FROM baumy_facts WHERE group_id = $1 AND event_at IS NOT NULL ORDER BY predicate', [G])
    expect(rows.rows.map((r: { predicate: string; valid_to: Date }) => [r.predicate, r.valid_to.toISOString()])).toEqual([
      ['hosts_party', '2026-03-15T02:00:00.000Z'], // timed: start + 6h
      ['stays_in', '2026-03-14T22:59:59.999Z'], // all-day (local midnight start): the end of that Berlin day
    ])
    expect(await withSimulatedTime(sept, () => currentFactsForQuery(h.db, G, 'zosia staying'))).toHaveLength(0)
    // During the stay it was (and still would be) current.
    expect(await withSimulatedTime(new Date('2026-03-14T12:00:00Z'), () => currentFactsForQuery(h.db, G, 'zosia staying'))).toHaveLength(1)
  })

  it('fact model: migrations 0021/0022 + the lookup, hygiene, retrieval-arm and consolidation SQL on real Postgres (spec §7)', async () => {
    const G = '-100e2e-facts'
    await ensureRegistered(h.db, G, null)
    await upsertMember(h.db, G, '901', 'Chloe Smith', 'owner')
    await upsertMember(h.db, G, '902', 'Marco', 'member')
    // 0021: the conflict pointer (self-FK, ON DELETE SET NULL)
    const col = await h.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'baumy_facts' AND column_name = 'conflicts_with_fact_id'")
    expect(col.rows[0].is_nullable).toBe('YES')

    // 0022: legacy synonym predicates are renamed (raw rows, the pre-vocabulary shape); canonical ones untouched
    const [z] = await h.db.insert(entities).values({ groupId: G, kind: 'person', canonicalName: 'zosia' }).returning({ id: entities.id })
    for (const [p, v, at] of [['Arrival Date', 'friday', '2026-09-01T10:00:00Z'], ['arrives_on', 'saturday', '2026-09-02T10:00:00Z'], ['staying in', 'the cave', '2026-09-01T10:00:00Z']])
      await h.pool.query('INSERT INTO baumy_facts (group_id, subject_entity_id, predicate, object_value, recorded_at, valid_from, is_current) VALUES ($1, $2, $3, $4, $5, $5, true)', [G, z.id, p, v, at])
    // …and a FALSE lineage parent (a different predicate — the old "last fact about the subject") is dropped
    const [bins] = await h.db.insert(entities).values({ groupId: G, kind: 'thing', canonicalName: 'bins' }).returning({ id: entities.id })
    const parent = await h.pool.query("INSERT INTO baumy_facts (group_id, subject_entity_id, predicate, object_value, is_current) VALUES ($1, $2, 'colour', 'green', true) RETURNING id", [G, bins.id])
    await h.pool.query("INSERT INTO baumy_facts (group_id, subject_entity_id, predicate, object_value, is_current, derived_from_fact_id) VALUES ($1, $2, 'bin_day', 'friday', true, $3)", [G, bins.id, parent.rows[0].id])
    for (const stmt of readFileSync(join(process.cwd(), 'db/migrations/0022_normalise_fact_predicates.sql'), 'utf8').split('--> statement-breakpoint')) await h.pool.query(stmt)
    const lineage = await h.pool.query("SELECT predicate, derived_from_fact_id FROM baumy_facts WHERE group_id = $1 AND subject_entity_id = $2 AND object_value = 'friday'", [G, bins.id])
    expect(lineage.rows[0]).toEqual({ predicate: 'collection_day', derived_from_fact_id: null })
    await h.pool.query('DELETE FROM baumy_facts WHERE subject_entity_id = $1', [bins.id])
    const renamed = await h.pool.query('SELECT predicate, object_value FROM baumy_facts WHERE group_id = $1 ORDER BY predicate, object_value', [G])
    expect(renamed.rows.map((r: { predicate: string; object_value: string }) => `${r.predicate}=${r.object_value}`)).toEqual(['arrives_on=friday', 'arrives_on=saturday', 'stays_in=the cave'])

    // the sweep resolves the split the rename exposed (row-constructor IN, UPDATE … RETURNING)
    const at = new Date('2026-09-27T01:40:00Z')
    const r = await runHygieneSweep(h.db, G, at)
    expect(r.resolved).toBe(1)
    expect((await withSimulatedTime(at, () => currentFactsForQuery(h.db, G, 'when does zosia arrive?'))).map((x) => x.content)).toEqual(['zosia arrives on: saturday', 'zosia stays in: the cave'])

    // speaker aliases + whole-word / object-side / first-person lookup (text[] aliases through the driver)
    await ensureSpeakerEntity(h.db, G, '901', 'Chloe Smith')
    await withSimulatedTime(at, () => reconcileFact(h.db, { groupId: G, fact: { subject: 'Chloe Smith', subjectKind: 'person', predicate: 'is_away', object: 'this weekend' }, authoredBy: '901', trustLevel: 'trusted' }))
    await withSimulatedTime(at, () => reconcileFact(h.db, { groupId: G, fact: { subject: 'marta', subjectKind: 'person', predicate: 'stays_in', object: "chloe's room", objectKind: 'place' }, authoredBy: '902', trustLevel: 'untrusted' }))
    const ask = (q: string, speaker?: { memberId: string; firstName: string }) => withSimulatedTime(at, () => currentFactsForQuery(h.db, G, q, 5, [], { speaker })).then((x) => x.map((y) => y.content))
    expect(await ask('is chloe around this weekend?')).toEqual(['chloe is away: this weekend'])
    expect(await ask("who's in the cave?")).toEqual(['zosia stays in: the cave'])
    expect(await ask("who's in my room?", { memberId: '901', firstName: 'Chloe' })).toEqual(["marta stays in: chloe's room"])

    // the trust gate: a group correction by the SAME author takes; by someone else → a conflict row
    expect((await withSimulatedTime(at, () => reconcileFactDetailed(h.db, { groupId: G, fact: { subject: 'chloe', subjectKind: 'person', predicate: 'is_away', object: 'next weekend' }, authoredBy: '902', trustLevel: 'untrusted' }))).result).toBe('conflict')
    expect((await withSimulatedTime(at, () => reconcileFactDetailed(h.db, { groupId: G, fact: { subject: 'chloe', subjectKind: 'person', predicate: 'is_away', object: 'next weekend' }, authoredBy: '901', trustLevel: 'untrusted' }))).result).toBe('update')
    // …and the now-moot conflict is retired by the sweep
    expect((await runHygieneSweep(h.db, G, at)).retired).toBe(1)

    // retrieval: OR lexical arm + author arm; consolidation keyed on author
    const note = await captureMemory({ groupId: G, content: 'Zosia is staying in my room this weekend', memoryType: 'statement', authoredBy: '901', trustLevel: 'untrusted' }, { db: h.db, embed })
    const junk = async () => embedSync('completely unrelated vocabulary xyzzy plugh')
    expect((await retrieve('when does zosia arrive?', { groupId: G, floor: 0.99 }, { db: h.db, embed: junk })).map((m) => m.id)).toContain(note)
    expect((await retrieve('what did chloe say?', { groupId: G, floor: 0.99, authorId: '901' }, { db: h.db, embed: junk })).map((m) => m.id)).toContain(note)
    const other = await captureMemory({ groupId: G, content: 'Zosia is staying in my room this weekend', memoryType: 'statement', authoredBy: '902', trustLevel: 'untrusted' }, { db: h.db, embed })
    expect(other).not.toBe(note) // Marco's identical line is HIS note, not folded onto Chloe's (F9)
  })
  it('intake & actions: migration 0023 (forwarded_by), forwarded recall, edit supersession, series cancel, soft forget (spec §8)', async () => {
    const G = '-100e2e-intake'
    await ensureRegistered(h.db, G, null)
    await upsertMember(h.db, G, '911', 'Chloe', 'owner')
    await upsertMember(h.db, G, '912', 'Marco', 'member')
    // 0023: the forwarder column (FK → members, ON DELETE SET NULL)
    const col = await h.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'baumy_memory_items' AND column_name = 'forwarded_by'")
    expect(col.rows[0].is_nullable).toBe('YES')

    // D4: a member-forwarded note is stored unattributed with its forwarder, and every retrieval arm returns it labelled
    const fwd = await captureMemory({ groupId: G, content: 'Landlord: boiler inspection Tuesday 10am', memoryType: 'statement', authoredBy: null, trustLevel: 'forwarded', forwardedBy: '912' }, { db: h.db, embed })
    const junk = async () => embedSync('completely unrelated vocabulary xyzzy plugh')
    const hit = (await retrieve('when is the boiler inspection?', { groupId: G, floor: 0.99 }, { db: h.db, embed: junk })).find((m) => m.id === fwd)
    expect(hit).toMatchObject({ trustLevel: 'forwarded', forwardedBy: '912', authoredBy: null })

    // I1: an edit retires the original's note, cancels its unsent series (recursive CTE), and settles its facts
    const note = await captureMemory({ groupId: G, content: 'zosia arrives friday', memoryType: 'statement', authoredBy: '911', trustLevel: 'untrusted' }, { db: h.db, embed })
    const first = await reconcileFactDetailed(h.db, { groupId: G, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'arrives_on', object: 'friday' }, authoredBy: '911', trustLevel: 'untrusted', memoryItemId: note })
    const r1 = await createReminder(h.db, { groupId: G, deliverChatId: G, content: 'bins', fireAt: new Date('2026-10-02T18:00:00Z'), createdBy: '911', recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
    await claimReminder(h.db, r1)
    await markSent(h.db, r1)
    const r2 = await scheduleNextOccurrence(h.db, (await loadSeriesRow(h.db, r1))!, new Date('2026-10-02T18:01:00Z'), 'Europe/Berlin')
    await appendInbound(h.db, { groupId: G, chatId: G, messageId: 77, authorKind: 'member', authorMemberId: '911', authorName: 'Chloe', text: 'zosia arrives friday', trust: 'untrusted', replyToMessageId: null, threadId: null, sentAt: new Date() })
    await linkProduced(h.db, { chatId: G, messageId: 77 }, { memoryItemId: note, factIds: [first.factId!], reminderIds: [r1] })
    const map = await lookupEdit(h.db, { chatId: G, messageId: 77 })
    expect(map).toMatchObject({ processed: true, memoryItemId: note, factIds: [first.factId], reminderIds: [r1] })
    const w = await withdrawForEdit(h.db, G, map)
    expect(w).toEqual({ noteRetired: true, remindersCancelled: [r2] }) // the SENT first occurrence stays sent
    const statuses = await h.db.select({ id: reminders.id, status: reminders.status }).from(reminders).where(eq(reminders.groupId, G))
    expect(Object.fromEntries(statuses.map((x) => [x.id, x.status]))).toEqual({ [r1]: 'sent', [r2!]: 'cancelled' })
    const note2 = await captureMemory({ groupId: G, content: 'zosia arrives saturday', memoryType: 'statement', authoredBy: '911', trustLevel: 'untrusted' }, { db: h.db, embed })
    const fixed = await reconcileFactDetailed(h.db, { groupId: G, fact: { subject: 'zosia', subjectKind: 'person', predicate: 'arrives_on', object: 'saturday' }, authoredBy: '911', trustLevel: 'untrusted', memoryItemId: note2 })
    expect(fixed.result).toBe('update')
    const retracted = await settleEditedFacts(h.db, G, map, { produced: [fixed.factId!], kept: [], noteId: note2 })
    expect(retracted).toEqual([first.factId])
    const [newRow] = await h.db.select({ parent: facts.derivedFromFactId }).from(facts).where(eq(facts.id, fixed.factId!))
    expect(newRow.parent).toBeNull() // the typo is not "earlier" history
    const [oldNote] = await h.db.select({ active: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, note))
    expect(oldNote.active).toBe(false)

    // A7/A8: "forget Zosia" proposes her facts (subject side) and their source note; a soft forget hides both
    const m = await findMemoryToForget(h.db, G, { values: ['Zosia'], subject: 'Zosia', attribute: '' })
    expect(m.factIds).toEqual([fixed.factId])
    expect(m.noteIds).toContain(note2)
    const res = await forgetMemory(h.db, G, { ...m, mode: 'soft' })
    expect(res).toMatchObject({ facts: 1, messagesHidden: 1 })
    const [hidden] = await h.db.select({ active: memoryItems.isActive }).from(memoryItems).where(eq(memoryItems.id, note2))
    expect(hidden.active).toBe(false)

    // D2: a personal reminder's destination is its creator's DM only while they are an active member
    expect(await reminderDestination(h.db, { groupId: G, deliverChatId: '912', createdBy: '912' })).toEqual({ kind: 'dm', chatId: '912' })
    expect(await reminderDestination(h.db, { groupId: G, deliverChatId: '912', createdBy: '911' })).toBeNull()
  })

  it('phase-5 review: the purge keeps an edit map for a pending reminder series, a shared note survives an edit, forget sees stated ownership (real SQL)', async () => {
    const G = '-100e2e-review'
    await ensureRegistered(h.db, G, null)
    await upsertMember(h.db, G, '921', 'Chloe', 'owner')
    const T = new Date('2026-09-26T19:00:00Z')
    const base = { groupId: G, chatId: G, authorKind: 'member' as const, authorMemberId: '921', authorName: 'Chloe', trust: 'untrusted', replyToMessageId: null, threadId: null }
    const old = new Date(T.getTime() - 50 * 3_600_000)

    // purgeWindow: jsonb_array_elements_text + the recursive series walk — a row whose series still has a
    // scheduled occurrence keeps its map (text replaced), one whose reminder is over is deleted.
    const sent = await createReminder(h.db, { groupId: G, deliverChatId: G, content: 'plants', fireAt: new Date(T.getTime() - 3_600_000), createdBy: '921', recurrence: 'FREQ=WEEKLY;BYDAY=FR' })
    await claimReminder(h.db, sent)
    await markSent(h.db, sent)
    await scheduleNextOccurrence(h.db, (await loadSeriesRow(h.db, sent))!, new Date(T.getTime() - 3_500_000), 'Europe/Berlin')
    const over = await createReminder(h.db, { groupId: G, deliverChatId: G, content: 'over', fireAt: new Date(T.getTime() - 7_200_000), createdBy: '921' })
    await claimReminder(h.db, over)
    await markSent(h.db, over)
    await appendInbound(h.db, { ...base, messageId: 1, text: 'remind us to water the plants every friday', sentAt: old })
    await appendInbound(h.db, { ...base, messageId: 2, text: 'remind us of something over', sentAt: old })
    await linkProduced(h.db, { chatId: G, messageId: 1 }, { reminderIds: [sent] })
    await linkProduced(h.db, { chatId: G, messageId: 2 }, { reminderIds: [over] })
    expect(await purgeWindow(h.db, T)).toBe(1)
    const left = await h.pool.query('SELECT message_id, text_redacted FROM baumy_messages WHERE group_id = $1', [G])
    expect(left.rows).toEqual([{ message_id: '1', text_redacted: EXPIRED_WINDOW_TEXT }])
    expect((await lookupEdit(h.db, { chatId: G, messageId: 1 })).reminderIds).toEqual([sent])

    // withdrawForEdit: a note two window rows produced (a consolidated repeat) is not retired by editing one
    const note = await captureMemory({ groupId: G, content: 'the boiler is broken', memoryType: 'statement', authoredBy: '921', trustLevel: 'untrusted' }, { db: h.db, embed })
    await appendInbound(h.db, { ...base, messageId: 10, text: 'the boiler is broken', sentAt: T })
    await appendInbound(h.db, { ...base, messageId: 12, text: 'the boiler is broken', sentAt: T })
    await linkProduced(h.db, { chatId: G, messageId: 10 }, { memoryItemId: note })
    await linkProduced(h.db, { chatId: G, messageId: 12 }, { memoryItemId: note })
    expect((await withdrawForEdit(h.db, G, await lookupEdit(h.db, { chatId: G, messageId: 12 }))).noteRetired).toBe(false)
    await linkProduced(h.db, { chatId: G, messageId: 10 }, { memoryItemId: null })
    expect((await withdrawForEdit(h.db, G, await lookupEdit(h.db, { chatId: G, messageId: 12 }))).noteRetired).toBe(true)

    // forget: the structural possessor edge (system) is excluded, a stated belongs_to is not
    await reconcileFact(h.db, { groupId: G, fact: { subject: "chloe's bike", predicate: 'location', object: 'the shed' }, authoredBy: null, trustLevel: 'untrusted' })
    await reconcileFact(h.db, { groupId: G, fact: { subject: 'the ladder', predicate: 'owned_by', object: 'marco' }, authoredBy: null, trustLevel: 'untrusted' })
    expect((await findMemoryToForget(h.db, G, { values: [], subject: "chloe's bike", attribute: '' })).facts.map((f) => f.label)).toEqual(["chloe's bike location: the shed"])
    expect((await findMemoryToForget(h.db, G, { values: [], subject: 'the ladder', attribute: '' })).facts.map((f) => f.label)).toEqual(['ladder belongs to: marco'])
  })
})
