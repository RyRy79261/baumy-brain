// AUDIT REPRO (action flows: forget + confirm-tap). A PASSING test == the finding is confirmed
// (each asserts the CURRENT, buggy behaviour). Offline: PGlite + embedSync; Telegram mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { facts, houseConfig } from '@/db/schema'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { embedSync } from '@/lib/ai/embed'
import { reconcileFact } from '@/lib/memory/facts'
import { findMemoryToForget, forgetMemory } from '@/lib/memory/forget'
import { retrieve } from '@/lib/memory/retrieve'

const dbh: { db: any } = { db: null }
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))

// (The confirm-tap-scope suite — A1 — is fixed: see lib/inngest/functions/__tests__/callback.test.ts.)

process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const HOUSE = '-100actforget'
const CHARLI = 777
const emb = async (t: string) => embedSync(t)

beforeEach(async () => {
  process.env.BAUMY_HOUSE_CHAT_ID = HOUSE
  dbh.db = await makeTestDb()
  await ensureRegistered(dbh.db, HOUSE, null)
  await dbh.db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE }).onConflictDoNothing()
  await upsertMember(dbh.db, HOUSE, String(CHARLI), 'Charli', 'owner')
})

async function seedZuzkaFact() {
  await reconcileFact(dbh.db, {
    groupId: HOUSE,
    fact: { subject: 'zuzka', subjectKind: 'person', predicate: 'staying_in', object: "charli's room", objectKind: 'value' },
    authoredBy: String(CHARLI),
    trustLevel: 'untrusted',
  })
  const [f] = await dbh.db.select().from(facts).where(eq(facts.groupId, HOUSE))
  return f
}

describe('forget resolution / soft mode gaps', () => {
  it('"forget Zuzka" (value = the name) never matches facts whose SUBJECT is Zuzka — only object values are searched', async () => {
    await seedZuzkaFact()
    await captureMemory({ groupId: HOUSE, content: 'Zuzka is staying in my room this weekend', memoryType: 'fact', authoredBy: String(CHARLI), trustLevel: 'untrusted', salience: 0.85 }, { db: dbh.db, embed: emb })
    const m = await findMemoryToForget(dbh.db, HOUSE, { values: ['Zuzka'], subject: 'Zuzka', attribute: '' })
    expect(m.facts).toEqual([]) // the zuzka→staying_in fact is not proposed
    expect(m.noteIds.length).toBe(1) // → soft mode replies "That's only in past messages…"
  })

  it('SOFT forget hides the fact but the source note stays active and is still retrieved as grounding', async () => {
    const f = await seedZuzkaFact()
    await captureMemory({ groupId: HOUSE, content: 'Zuzka is staying in my room this weekend', memoryType: 'fact', authoredBy: String(CHARLI), trustLevel: 'untrusted', salience: 0.85 }, { db: dbh.db, embed: emb })
    const r = await forgetMemory(dbh.db, HOUSE, { factIds: [f.id], scrubValues: ["charli's room"], noteIds: [], aliasHits: [], mode: 'soft' })
    expect(r.facts).toBe(1)
    const hits = await retrieve('where is Zuzka staying this weekend', { groupId: HOUSE, k: 8, floor: 0.05 }, { db: dbh.db, embed: emb })
    expect(hits.some((h) => h.content.includes('Zuzka is staying in my room'))).toBe(true) // "forgotten" info still answers
  })

  it('subject+attribute lookup requires EVERY attribute word inside predicate+value (natural phrasing misses)', async () => {
    await seedZuzkaFact() // predicate staying_in, value "charli's room"
    const m = await findMemoryToForget(dbh.db, HOUSE, { values: [], subject: 'Zuzka', attribute: 'where she is sleeping' })
    expect(m.facts).toEqual([]) // "sleeping"/"where"/"she" not in "staying in charli's room" → "Nothing like that in my memory"
  })
})
