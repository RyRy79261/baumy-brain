import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

// The reply's MEMORY block on a REAL PGlite database (hybrid recall + facts): this turn's own
// evidence note and facts are excluded (C1), pre-v2 question notes never ground (I3), every row is
// dated (T1), and a secret is decrypted only for a direct ask in answer mode (C15).
vi.mock('@/lib/ai/embed', async (o) => {
  const actual = await o<typeof import('@/lib/ai/embed')>()
  return { ...actual, embed: async (t: string) => actual.embedSync(t), embedMany: async (ts: string[]) => ts.map((t) => actual.embedSync(t)) }
})
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64')

const { makeTestDb } = await import('@/lib/memory/__tests__/pglite')
const { ensureRegistered, captureMemory } = await import('@/lib/memory/write')
const { upsertMember } = await import('@/lib/identity/roster')
const { reconcileFactDetailed, currentFactsForQuery } = await import('@/lib/memory/facts')
const { retrieve } = await import('@/lib/memory/retrieve')
const { gatherGrounding, disclose } = await import('@/lib/turn/grounding')
const { buildTurnContext } = await import('@/lib/turn/context')
const { withSimulatedTime } = await import('@/lib/core/clock')
const { memoryItems } = await import('@/db/schema')
const { encryptSecret } = await import('@/lib/core/crypto')

const G = '-100ground'
// Every read of a DATED fact runs at a pinned instant (the question's own time): "current" is judged
// against the clock (liveFact), so a read on the wall clock would expire the Sun 27 Sep event below
// the day after the suite was written — a time bomb, not a test.
const ASKED = new Date('2026-09-26T19:40:00Z')
const CHARLI = '701'
const MARCO = '702'
type Db = Awaited<ReturnType<typeof makeTestDb>>
let db: Db

const ctxFor = (text: string, authorId = MARCO) =>
  buildTurnContext({
    updateId: 1,
    messageId: 1,
    chatId: G,
    houseScope: G,
    lane: 'house',
    fromId: Number(authorId),
    senderName: authorId === CHARLI ? 'Charli' : 'Marco',
    isOwner: false,
    anonymous: false,
    authorId,
    trust: 'untrusted',
    sentAt: ASKED,
    tz: 'Europe/Berlin',
    threadId: null,
    isConsole: false,
    directed: { value: true, why: 'mention' },
    replyTo: null,
    text,
  })

beforeEach(async () => {
  db = await makeTestDb()
  await ensureRegistered(db, G, null)
  await upsertMember(db, G, CHARLI, 'Charli', 'owner')
  await upsertMember(db, G, MARCO, 'Marco', 'member')
})

describe('reconcileFactDetailed / exclusion seams', () => {
  it('returns WHICH fact row it wrote: new id on add/update, the incumbent on noop, null on reject', async () => {
    const f = { subject: 'bins', predicate: 'go_out', object: 'friday' }
    const a = await reconcileFactDetailed(db, { groupId: G, fact: f, authoredBy: null, trustLevel: 'untrusted' })
    expect(a.result).toBe('add')
    expect(a.factId).toBeTruthy()
    expect(await reconcileFactDetailed(db, { groupId: G, fact: f, authoredBy: null, trustLevel: 'untrusted' })).toEqual({ result: 'noop', factId: a.factId })
    const u = await reconcileFactDetailed(db, { groupId: G, fact: { ...f, object: 'monday' }, authoredBy: null, trustLevel: 'untrusted' })
    expect(u.result).toBe('update')
    expect(u.factId).not.toBe(a.factId)
    expect(await reconcileFactDetailed(db, { groupId: G, fact: f, authoredBy: null, trustLevel: 'quarantined' })).toEqual({ result: 'rejected', factId: null })
  })

  it('currentFactsForQuery leaves out excluded ids and carries recorded_at / event_at (T1)', async () => {
    const at = new Date('2026-09-12T10:00:00Z')
    const r = await withSimulatedTime(at, () =>
      reconcileFactDetailed(db, { groupId: G, fact: { subject: 'zuzka', predicate: 'stays_in', object: "charli's room" }, authoredBy: CHARLI, trustLevel: 'untrusted', eventAt: new Date('2026-09-27T08:00:00Z') }),
    )
    const [hit] = await withSimulatedTime(ASKED, () => currentFactsForQuery(db, G, 'is zuzka here'))
    expect(hit.id).toBe(r.factId)
    expect(hit.recordedAt?.toISOString()).toBe(at.toISOString())
    expect(hit.eventAt?.toISOString()).toBe('2026-09-27T08:00:00.000Z')
    expect(await withSimulatedTime(ASKED, () => currentFactsForQuery(db, G, 'is zuzka here', 5, [r.factId!]))).toEqual([])
  })

  it('retrieve leaves out excluded memory ids', async () => {
    const id = await captureMemory({ groupId: G, content: 'the plumber comes thursday', memoryType: 'statement', authoredBy: CHARLI, trustLevel: 'untrusted' }, { db })
    expect((await retrieve('plumber thursday', { groupId: G, floor: 0 }, { db })).map((m) => m.id)).toContain(id)
    expect((await retrieve('plumber thursday', { groupId: G, floor: 0, excludeIds: [id] }, { db })).map((m) => m.id)).not.toContain(id)
  })

  it('captureMemory stamps created_at from the clock seam (the note date the reply shows)', async () => {
    const at = new Date('2026-03-12T18:00:00Z')
    const id = await withSimulatedTime(at, () => captureMemory({ groupId: G, content: 'old news', memoryType: 'statement', authoredBy: null, trustLevel: 'untrusted' }, { db }))
    const [row] = await db.select().from(memoryItems).where(eq(memoryItems.id, id))
    expect(row.createdAt.toISOString()).toBe(at.toISOString())
  })
})

describe('gatherGrounding — the MEMORY block', () => {
  it('C1: excludes THIS turn’s own evidence note and the facts it just wrote; earlier memory stays', async () => {
    await captureMemory({ groupId: G, content: 'Zuzka lands friday evening', memoryType: 'statement', authoredBy: MARCO, trustLevel: 'untrusted' }, { db })
    const own = await captureMemory({ groupId: G, content: 'Zuzka is staying in my room this weekend', memoryType: 'statement', authoredBy: CHARLI, trustLevel: 'untrusted' }, { db })
    const f = await reconcileFactDetailed(db, { groupId: G, fact: { subject: 'zuzka', predicate: 'stays_in', object: "charli's room" }, authoredBy: CHARLI, trustLevel: 'untrusted', memoryItemId: own })
    const ctx = ctxFor('Zuzka is staying in my room this weekend', CHARLI)
    ctx.outcome.captured = { memoryItemId: own, factIds: [f.factId!], learned: [], rejected: [] }

    const g = await gatherGrounding(db, ctx, { deep: false, mode: 'ack' })
    const contents = g.items.map((i) => i.content)
    expect(contents).not.toContain('Zuzka is staying in my room this weekend')
    expect(contents.some((c) => c.includes("charli's room"))).toBe(false)
    expect(contents).toContain('Zuzka lands friday evening')
    const note = g.items.find((i) => i.content === 'Zuzka lands friday evening')!
    expect(note).toMatchObject({ kind: 'note', who: 'Marco' })
    expect(note.saidAt).toBeInstanceOf(Date)
  })

  it('without a capture this turn, the same fact DOES ground a later question — dated and attributed', async () => {
    await withSimulatedTime(new Date('2026-09-20T10:00:00Z'), () =>
      reconcileFactDetailed(db, { groupId: G, fact: { subject: 'zuzka', predicate: 'stays_in', object: "charli's room" }, authoredBy: CHARLI, trustLevel: 'untrusted', eventAt: new Date('2026-09-27T08:00:00Z') }),
    )
    const g = await withSimulatedTime(ASKED, () => gatherGrounding(db, ctxFor('where is zuzka staying?'), { deep: false, mode: 'answer' }))
    const fact = g.items.find((i) => i.kind === 'fact')!
    expect(fact).toMatchObject({ who: 'Charli', content: "zuzka stays in: charli's room" })
    expect(fact.saidAt).toBeInstanceOf(Date)
    expect(fact.eventAt?.toISOString()).toBe('2026-09-27T08:00:00.000Z')
  })

  it('I3: an old QUESTION / chatter note never grounds an answer', async () => {
    await captureMemory({ groupId: G, content: 'is the plumber coming on thursday?', memoryType: 'question', authoredBy: MARCO, trustLevel: 'untrusted' }, { db })
    await captureMemory({ groupId: G, content: 'plumber lol', memoryType: 'chatter', authoredBy: MARCO, trustLevel: 'untrusted' }, { db })
    const g = await gatherGrounding(db, ctxFor('when is the plumber coming?'), { deep: false, mode: 'answer' })
    expect(g.items).toEqual([]) // → the honest "nobody has mentioned that" can fire
  })

  it('C15: a secret is decrypted only for a direct ask in MODE answer — never for an ack, never for a mere mention', async () => {
    await captureMemory({ groupId: G, content: 'the wifi password is hunter2', memoryType: 'statement', authoredBy: CHARLI, trustLevel: 'untrusted' }, { db })
    const ask = await gatherGrounding(db, ctxFor("what's the wifi password?"), { deep: false, mode: 'answer' })
    expect(ask.items.some((i) => i.content.includes('hunter2'))).toBe(true)
    expect(ask.forWeb.some((i) => i.content.includes('hunter2'))).toBe(false) // the tool-enabled path never sees it
    const ack = await gatherGrounding(db, ctxFor('the wifi password changed btw'), { deep: false, mode: 'ack' })
    expect(ack.items.some((i) => i.content.includes('hunter2'))).toBe(false)
    const mention = await gatherGrounding(db, ctxFor('is the wifi slow for anyone else?'), { deep: false, mode: 'answer' })
    expect(mention.items.some((i) => i.content.includes('hunter2'))).toBe(false)
  })

  it('disclose keeps an undecryptable blob as its descriptor instead of failing the reply', () => {
    const items = [{ kind: 'fact' as const, who: null, saidAt: null, content: 'front door code', isSecure: true, contentEncrypted: 'garbage' }]
    expect(disclose(items, 'answer', "what's the front door code?")[0].content).toBe('front door code')
    const good = [{ ...items[0], contentEncrypted: encryptSecret('4821') }]
    expect(disclose(good, 'answer', "what's the front door code?")[0].content).toBe('front door code: 4821')
    expect(disclose(good, 'confirm', "what's the front door code?")[0].content).toBe('front door code')
  })
})
