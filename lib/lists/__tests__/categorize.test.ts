import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig, listCategories, listItemEmbeddings, listItems } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { EMBED_DIM, EMBED_MODEL, embedSync } from '@/lib/ai/embed'
import { addListItems, currentList, rememberedCategory, renameItem, setItemCategory } from '@/lib/lists/store'
import type { Category } from '@/lib/lists/categories'
import type { Database } from '@/db/client'

// Auto-sorting after an add (issue #29, docs/spec/shopping-list.md §Categories): remembered pick →
// nearest sorted item by embedding (current model only, at or above the floor) → the model's guess.

const sent: { name: string; data: unknown }[] = []
const refresh = vi.fn(async (_g: string) => {})
vi.mock('@/lib/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inngest/client')>()
  return {
    ...actual,
    inngest: {
      ...actual.inngest,
      send: async (e: { name: string; data: unknown }) => {
        sent.push(e)
        return { ids: [] }
      },
    },
  }
})
vi.mock('@/lib/lists/board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lists/board')>()
  return { ...actual, requestShoppingRefresh: (g: string) => refresh(g) }
})
const { autoCategorizeItem, runCategorize, requestCategorize, nearestSorted, backfillCandidates, SIMILAR_FLOOR, SHOPPING_CATEGORIZE } = await import('@/lib/lists/categorize')
const { runShoppingRender } = await import('@/lib/lists/board')
const { setGlobalEnabled } = await import('@/lib/policy')
const { captureOutbound } = await import('@/lib/telegram/outbox')

const G = '-100sortHouse'
const OTHER = '-100otherHouse'
const inline = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() }

// A unit vector whose cosine with AXIS is exactly `cos` (512-dim, the column's size).
const vec = (cos: number, axis = 0, other = 1): number[] => {
  const v = new Array<number>(EMBED_DIM).fill(0)
  v[axis] = cos
  v[other] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}
// An embedder from a fixed table (by the normalized name); any other name gets the lexical test embedder
// (distinct names land far apart).
const table = (t: Record<string, number[]>) => vi.fn(async (text: string) => t[text] ?? embedSync(text))

async function setup(): Promise<Database> {
  const db = await makeTestDb()
  await ensureRegistered(db, G, null)
  await ensureRegistered(db, OTHER, null)
  return db
}
async function add(db: Database, item: string, groupId = G): Promise<string> {
  const r = await addListItems(db, { groupId, items: [item], addedBy: null })
  return r.addedIds[0]
}
const rowOf = async (db: Database, id: string) => (await db.select({ c: listItems.category, s: listItems.categorySource }).from(listItems).where(eq(listItems.id, id)))[0]
// Sort an item fully and keep it sorted: an anchor for the similar tier.
async function anchor(db: Database, item: string, category: Category, v: number[], groupId = G, model = EMBED_MODEL) {
  const id = await add(db, item, groupId)
  await db.update(listItems).set({ category, categorySource: 'guessed' }).where(eq(listItems.id, id))
  await db.insert(listItemEmbeddings).values({ groupId, itemNormalized: item, model, embedding: v })
  return id
}

beforeEach(() => {
  sent.length = 0
  refresh.mockClear()
})

describe('auto-sorting — the three tiers, in order', () => {
  it('REMEMBERED beats similar beats guess: the house pick wins even with a closer sorted item and a model answer', async () => {
    const db = await setup()
    await setItemCategory(db, { groupId: G, id: await add(db, 'oat milk'), category: 'coffee', by: null }) // the pick → memory
    await db.update(listItems).set({ isActive: false }).where(eq(listItems.groupId, G)) // bought / gone
    await anchor(db, 'oat drink', 'fresh', vec(1)) // a similar item, sorted Fresh
    const guess = vi.fn(async () => 'pantry' as const)
    const id = await add(db, 'Oat Milk')
    const r = await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({ 'oat milk': vec(0.99) }), guess })
    expect(r).toMatchObject({ outcome: 'categorized', category: 'coffee', source: 'remembered' })
    expect(await rowOf(db, id)).toEqual({ c: 'coffee', s: 'remembered' })
    expect(guess).not.toHaveBeenCalled()
  })

  it('SIMILAR beats guess: the nearest sorted item at or above the floor lends its category', async () => {
    const db = await setup()
    await anchor(db, 'oat milk', 'fresh', vec(1))
    const guess = vi.fn(async () => 'pantry' as const)
    const id = await add(db, 'oatly barista')
    const r = await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({ 'oatly barista': vec(0.9) }), guess })
    expect(r).toMatchObject({ outcome: 'categorized', category: 'fresh', source: 'similar', similarTo: 'oat milk' })
    expect((r as { similarity: number }).similarity).toBeCloseTo(0.9, 5)
    expect(guess).not.toHaveBeenCalled()
  })

  it('exactly AT the floor counts; just BELOW it falls through to the guess', async () => {
    const db = await setup()
    await anchor(db, 'bin bags', 'cleaning', vec(1))
    const at = await add(db, 'bin liners')
    // [4, 3] against [1, 0] is a cosine of exactly 4/5 = SIMILAR_FLOOR, exact in float4 and double — so
    // this pins `>=` (a strict `>` sends it to the guess).
    expect(SIMILAR_FLOOR).toBe(0.8)
    const fourThree = Object.assign(new Array<number>(EMBED_DIM).fill(0), { 0: 4, 1: 3 })
    const r1 = await autoCategorizeItem(db, { groupId: G, itemId: at }, { embed: table({ 'bin liners': fourThree }), guess: async () => 'household' })
    expect(r1).toMatchObject({ source: 'similar', category: 'cleaning', similarity: SIMILAR_FLOOR })
    const below = await add(db, 'bin brush')
    const guess = vi.fn(async () => 'household' as const)
    const r2 = await autoCategorizeItem(db, { groupId: G, itemId: below }, { embed: table({ 'bin brush': vec(SIMILAR_FLOOR - 0.01, 0, 2) }), guess })
    expect(r2).toMatchObject({ outcome: 'categorized', category: 'household', source: 'guessed' })
    expect(guess).toHaveBeenCalledWith('bin brush')
  })

  it('GUESSED when nothing is remembered or similar; a model with nothing to say leaves it Not sorted', async () => {
    const db = await setup()
    const id = await add(db, 'oat milk')
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({}), guess: async () => 'fresh' })).toMatchObject({ source: 'guessed', category: 'fresh' })
    const id2 = await add(db, 'zorblax')
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id2 }, { embed: table({}), guess: async () => null })).toEqual({ outcome: 'unsorted', id: id2 })
    expect(await rowOf(db, id2)).toEqual({ c: null, s: null })
  })

  it('a guess that is not an enum value is re-checked by code: Not sorted', async () => {
    const db = await setup()
    const id = await add(db, 'oat milk')
    const r = await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({}), guess: async () => 'drinks' as unknown as Category })
    expect(r.outcome).toBe('unsorted')
    expect(await rowOf(db, id)).toEqual({ c: null, s: null })
  })

  it('never compares across embedding models: an identical vector stored under another model is no anchor', async () => {
    const db = await setup()
    await anchor(db, 'oat milk', 'fresh', vec(1), G, 'some-older-model')
    const guess = vi.fn(async () => 'coffee' as const)
    const id = await add(db, 'oat milk 2')
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({ 'oat milk 2': vec(1) }), guess })).toMatchObject({ source: 'guessed' })
    expect(guess).toHaveBeenCalled()
    // present: under the CURRENT model the same vector IS the anchor
    await anchor(db, 'oat milk', 'fresh', vec(1))
    const id2 = await add(db, 'oat milk 3')
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id2 }, { embed: table({ 'oat milk 3': vec(1) }), guess })).toMatchObject({ source: 'similar', category: 'fresh' })
  })

  it('is house-scoped: another house\'s sorted items and picks never lend a category', async () => {
    const db = await setup()
    await anchor(db, 'oat milk', 'coffee', vec(1), OTHER)
    await setItemCategory(db, { groupId: OTHER, item: 'oat milk', category: 'coffee', by: null })
    const id = await add(db, 'oat milk')
    const guess = vi.fn(async () => 'fresh' as const)
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({ 'oat milk': vec(1) }), guess })).toMatchObject({ source: 'guessed', category: 'fresh' })
    // and a row id from another house is never sorted from here
    const theirs = await add(db, 'bread', OTHER)
    expect(await autoCategorizeItem(db, { groupId: G, itemId: theirs }, { embed: table({}), guess })).toEqual({ outcome: 'skipped', id: theirs })
  })

  it('a housemate\'s pick that landed first is never overwritten (compare-and-set on the source)', async () => {
    const db = await setup()
    const id = await add(db, 'oat milk')
    await setItemCategory(db, { groupId: G, id, category: 'coffee', by: null })
    const guess = vi.fn(async () => 'fresh' as const)
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({}), guess })).toEqual({ outcome: 'skipped', id })
    expect(await rowOf(db, id)).toEqual({ c: 'coffee', s: 'picked' })
    expect(guess).not.toHaveBeenCalled()
  })

  it('a pick that lands WHILE the model is guessing still wins: the write is compare-and-set on the source', async () => {
    const db = await setup()
    const id = await add(db, 'oat milk')
    const guess = vi.fn(async () => {
      await setItemCategory(db, { groupId: G, id, category: 'coffee', by: null }) // a housemate, mid-guess
      return 'fresh' as const
    })
    expect(await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({}), guess })).toEqual({ outcome: 'skipped', id })
    expect(guess).toHaveBeenCalled()
    expect(await rowOf(db, id)).toEqual({ c: 'coffee', s: 'picked' })
  })

  it('a "Not sorted" pick forgets the memory, and a name whose LATEST sort was that pick lends nothing — even with an older sorted row of it', async () => {
    const db = await setup()
    // an older row of the name, guessed Household and bought…
    const older = await anchor(db, 'candles', 'household', vec(1))
    await db.update(listItems).set({ checkedAt: new Date('2026-10-01T10:00:00Z'), categorizedAt: new Date('2026-10-01T09:00:00Z') }).where(eq(listItems.id, older))
    // …and a newer one, picked Household: the name IS an anchor now
    const newer = await add(db, 'candles')
    await setItemCategory(db, { groupId: G, id: newer, category: 'household', by: null })
    expect(await rememberedCategory(db, G, 'candles')).toBe('household')
    expect(await nearestSorted(db, { groupId: G, vector: vec(1) })).toMatchObject({ item: 'candles', category: 'household' })
    // the newer row is picked "Not sorted": the memory goes, and the older row's Household is not used either
    await setItemCategory(db, { groupId: G, id: newer, category: null, by: null })
    expect(await rememberedCategory(db, G, 'candles')).toBeNull()
    expect(await nearestSorted(db, { groupId: G, vector: vec(1) })).toBeNull()
  })

  it('an embedder failure skips only the similar tier — the guess still runs', async () => {
    const db = await setup()
    await anchor(db, 'oat milk', 'fresh', vec(1))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await add(db, 'soy milk')
    const r = await autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: async () => Promise.reject(new Error('voyage 503')), guess: async () => 'fresh' })
    expect(r).toMatchObject({ source: 'guessed', category: 'fresh' })
    warn.mockRestore()
  })

  it('stores ONE vector per item name (current model), whatever tier won, and reuses it', async () => {
    const db = await setup()
    const embed = table({ 'oat milk': vec(1) })
    await autoCategorizeItem(db, { groupId: G, itemId: await add(db, 'oat milk') }, { embed, guess: async () => 'fresh' })
    await db.update(listItems).set({ checkedAt: new Date() }).where(eq(listItems.groupId, G))
    await autoCategorizeItem(db, { groupId: G, itemId: await add(db, 'Oat milk') }, { embed, guess: async () => 'pantry' })
    expect(embed).toHaveBeenCalledTimes(1)
    const vs = await db.select().from(listItemEmbeddings).where(and(eq(listItemEmbeddings.groupId, G), eq(listItemEmbeddings.itemNormalized, 'oat milk')))
    expect(vs).toHaveLength(1)
    expect(vs[0].model).toBe(EMBED_MODEL)
  })
})

describe('auto-sorting never blocks or fails the add', () => {
  it('the add commits first; a model that keeps failing leaves the item on the list, Not sorted', async () => {
    const db = await setup()
    const id = await add(db, 'oat milk')
    await expect(
      autoCategorizeItem(db, { groupId: G, itemId: id }, { embed: table({}), guess: async () => Promise.reject(new Error('529 overloaded')) }),
    ).rejects.toThrow(/overloaded/) // the step retries (I2)…
    // …and the item is on the list all the same.
    expect((await currentList(db, G)).map((r) => [r.item, r.category])).toEqual([['oat milk', null]])
  })

  it('requestCategorize is best-effort: Inngest down → false, nothing thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { inngest } = await import('@/lib/inngest/client')
    const spy = vi.spyOn(inngest, 'send').mockRejectedValueOnce(new Error('inngest down'))
    await expect(requestCategorize(G, ['00000000-0000-4000-8000-000000000001'])).resolves.toBe(false)
    spy.mockRestore()
    expect(await requestCategorize(G, ['00000000-0000-4000-8000-000000000001'])).toBe(true)
    expect(sent.at(-1)).toEqual({ name: SHOPPING_CATEGORIZE, data: { groupId: G, itemIds: ['00000000-0000-4000-8000-000000000001'] } })
    expect(await requestCategorize(G, [])).toBe(false) // nothing to sort, nothing sent
    warn.mockRestore()
  })
})

describe('runCategorize — the Inngest body', () => {
  it('sorts each id in its own step, then asks for ONE debounced re-render when anything was sorted', async () => {
    const db = await setup()
    const a = await add(db, 'oat milk')
    const b = await add(db, 'zorblax')
    const steps: string[] = []
    const step = { run: async <T>(id: string, fn: () => Promise<T>) => (steps.push(id), fn()) }
    const out = await runCategorize(step, () => db, { groupId: G, itemIds: [a, b] }, { embed: table({}), guess: async (i) => (i === 'oat milk' ? 'fresh' : null) })
    expect(out.map((r) => r.outcome)).toEqual(['categorized', 'unsorted'])
    expect(steps).toEqual(['categorize-embed', `categorize-${a}`, `categorize-${b}`, 'categorize-render'])
    expect(refresh).toHaveBeenCalledWith(G)
  })

  it('nothing sorted → no re-render', async () => {
    const db = await setup()
    const a = await add(db, 'zorblax')
    await runCategorize(inline, () => db, { groupId: G, itemIds: [a] }, { embed: table({}), guess: async () => null })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('setItemCategory — a housemate\'s pick', () => {
  it('by id or by text (exact, then the one loose match); teaches the memory; attributed', async () => {
    const db = await setup()
    await upsertMember(db, G, '42', 'Ryan', 'member')
    const id = await add(db, 'coffee filters')
    expect(await setItemCategory(db, { groupId: G, item: 'the coffee filter', category: 'coffee', by: '42' })).toMatchObject({ outcome: 'set', item: 'coffee filters', category: 'coffee', id })
    const [row] = await db.select().from(listItems).where(eq(listItems.id, id))
    expect(row).toMatchObject({ category: 'coffee', categorySource: 'picked', categorizedBy: '42' })
    const [mem] = await db.select().from(listCategories).where(eq(listCategories.groupId, G))
    expect(mem).toMatchObject({ itemNormalized: 'coffee filters', category: 'coffee', pickedBy: '42' })
    // a later pick replaces the memory (one row per item)
    await setItemCategory(db, { groupId: G, id, category: 'household', by: null })
    expect(await db.select().from(listCategories).where(eq(listCategories.groupId, G))).toHaveLength(1)
    expect(await rememberedCategory(db, G, 'coffee filters')).toBe('household')
  })

  it('a miss or an ambiguous name changes nothing and teaches nothing; another house\'s id is a miss', async () => {
    const db = await setup()
    await add(db, 'sponge')
    await add(db, 'sponges')
    expect(await setItemCategory(db, { groupId: G, item: 'nutmeg', category: 'pantry', by: null })).toMatchObject({ outcome: 'not_found', item: 'nutmeg' })
    expect(await setItemCategory(db, { groupId: G, item: 'Sponge', category: 'cleaning', by: null })).toMatchObject({ outcome: 'set', item: 'sponge' }) // the exact key wins
    const theirs = await add(db, 'bread', OTHER)
    expect(await setItemCategory(db, { groupId: G, id: theirs, category: 'fresh', by: null })).toMatchObject({ outcome: 'not_found', item: null })
    expect((await db.select().from(listItems).where(eq(listItems.id, theirs)))[0].category).toBeNull()
    expect(await rememberedCategory(db, G, 'nutmeg')).toBeNull()
    expect(await rememberedCategory(db, G, 'bread')).toBeNull()
  })

  it('a name that loosely fits more than one open item is ambiguous: it names them and changes nothing', async () => {
    const db = await setup()
    await add(db, 'sponge')
    await add(db, 'sponges')
    const r = await setItemCategory(db, { groupId: G, item: 'a sponge', category: 'cleaning', by: null })
    expect(r).toMatchObject({ outcome: 'ambiguous', item: 'a sponge' })
    expect([...(r.matches ?? [])].sort()).toEqual(['sponge', 'sponges'])
    expect((await currentList(db, G)).map((x) => x.category)).toEqual([null, null])
    expect(await rememberedCategory(db, G, 'sponge')).toBeNull()
  })
})

describe('review fixes (PR #30)', () => {
  it('one item failing for good never kills the batch: it stays Not sorted (marked tried), the others are sorted, the render is still sent', async () => {
    const db = await setup()
    const a = await add(db, 'oat milk')
    const b = await add(db, 'cursed item')
    const c = await add(db, 'pasta')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guess = async (i: string) => {
      if (i === 'cursed item') throw new Error('529 overloaded') // still failing after the step's retries
      return i === 'oat milk' ? ('fresh' as const) : ('pantry' as const)
    }
    const out = await runCategorize(inline, () => db, { groupId: G, itemIds: [a, b, c] }, { embed: table({}), guess })
    expect(out.map((r) => r.outcome)).toEqual(['categorized', 'failed', 'categorized'])
    expect(refresh).toHaveBeenCalledWith(G)
    expect(await rowOf(db, b)).toEqual({ c: null, s: null })
    const [tried] = await db.select({ at: listItems.categorizedAt }).from(listItems).where(eq(listItems.id, b))
    expect(tried.at).not.toBeNull() // never re-tried by a backfill
    expect(await rowOf(db, c)).toEqual({ c: 'pantry', s: 'guessed' })
    err.mockRestore()
  })

  it('embeds the whole batch in ONE embedder call (only names without a current-model vector)', async () => {
    const db = await setup()
    await anchor(db, 'pasta', 'pantry', embedSync('pasta'))
    const ids = [await add(db, 'oat milk'), await add(db, 'rice'), await add(db, 'pasta 2')]
    const embedMany = vi.fn(async (ts: string[]) => ts.map(embedSync))
    const embed = vi.fn(async (t: string) => embedSync(t))
    await runCategorize(inline, () => db, { groupId: G, itemIds: ids }, { embed, embedMany, guess: async () => null })
    expect(embedMany).toHaveBeenCalledTimes(1)
    expect([...embedMany.mock.calls[0][0]].sort()).toEqual(['oat milk', 'pasta 2', 'rice'])
    expect(embed).not.toHaveBeenCalled() // every item found its vector already stored
  })

  it('backfill: open rows auto-sorting never saw are sorted once — old, open, untried only — and never again', async () => {
    const db = await setup()
    // three rows from before auto-sorting existed (an hour ago), one bought, one just added
    const old1 = await add(db, 'oat milk')
    const old2 = await add(db, 'zorblax')
    const bought = await add(db, 'bread')
    await db.update(listItems).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(listItems.groupId, G))
    await db.update(listItems).set({ checkedAt: new Date() }).where(eq(listItems.id, bought))
    const fresh = await add(db, 'rice')
    expect([...(await backfillCandidates(db, G))].sort()).toEqual([old1, old2].sort())
    await runCategorize(inline, () => db, { groupId: G, itemIds: await backfillCandidates(db, G) }, { embed: table({}), guess: async (i) => (i === 'oat milk' ? 'fresh' : null) })
    expect(await rowOf(db, old1)).toEqual({ c: 'fresh', s: 'guessed' })
    expect(await rowOf(db, old2)).toEqual({ c: null, s: null }) // the model had nothing: Not sorted…
    expect(await backfillCandidates(db, G)).toEqual([]) // …and never picked up again (idempotent)
    // a repeated event for it (a retried send, a second backfill) never asks the model again
    const again = vi.fn(async () => 'fresh' as const)
    expect(await runCategorize(inline, () => db, { groupId: G, itemIds: [old2] }, { embed: table({}), guess: again })).toEqual([{ outcome: 'skipped', id: old2 }])
    expect(again).not.toHaveBeenCalled()
    expect(fresh).toBeTruthy()
  })

  it('the backfill is sent by a live-list render, after it, and only when there is something to sort', async () => {
    const db = await setup()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: G })
    const old = await add(db, 'oat milk')
    await db.update(listItems).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(listItems.id, old))
    const steps: string[] = []
    const step = { run: async <T>(id: string, fn: () => Promise<T>) => (steps.push(id), fn()) }
    await runShoppingRender(step, () => db, { groupId: G, reason: 'change' })
    expect(steps.at(-1)).toBe('live-backfill')
    expect(sent.filter((e) => e.name === SHOPPING_CATEGORIZE)).toEqual([{ name: SHOPPING_CATEGORIZE, data: { groupId: G, itemIds: [old] } }])
    // once tried, a render sends nothing more
    await runCategorize(inline, () => db, { groupId: G, itemIds: [old] }, { embed: table({}), guess: async () => null })
    sent.length = 0
    await runShoppingRender(step, () => db, { groupId: G, reason: 'change' })
    expect(sent.filter((e) => e.name === SHOPPING_CATEGORIZE)).toEqual([])
  })

  it('no backfill while the house is paused — not on a held change render, not on a tap render; it resumes after', async () => {
    const db = await setup()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: G, shoppingMessageChatId: G, shoppingMessageId: 77 })
    const old = await add(db, 'oat milk')
    await db.update(listItems).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(listItems.id, old))
    await setGlobalEnabled(db, false)
    const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() }
    const held = await captureOutbound(() => runShoppingRender(step, () => db, { groupId: G, reason: 'change' }))
    expect(held.result).toEqual({ status: 'paused' })
    await captureOutbound(() => runShoppingRender(step, () => db, { groupId: G, reason: 'tap', page: 1 }))
    expect(sent.filter((e) => e.name === SHOPPING_CATEGORIZE)).toEqual([])
    // present: once resumed, the same render sends it
    await setGlobalEnabled(db, true)
    await captureOutbound(() => runShoppingRender(step, () => db, { groupId: G, reason: 'change' }))
    expect(sent.filter((e) => e.name === SHOPPING_CATEGORIZE)).toEqual([{ name: SHOPPING_CATEGORIZE, data: { groupId: G, itemIds: [old] } }])
  })

  it('a housemate\'s pick gets a vector (via the categorize run), so it lends its category to a similar later item', async () => {
    const db = await setup()
    const filters = await add(db, 'coffee filters')
    await setItemCategory(db, { groupId: G, id: filters, category: 'coffee', by: null })
    const vectors = { 'coffee filters': vec(1), 'coffee filter papers': vec(0.95) }
    // before: no vector for the picked name → no anchor
    expect(await nearestSorted(db, { groupId: G, vector: vec(0.95) })).toBeNull()
    const out = await runCategorize(inline, () => db, { groupId: G, itemIds: [filters] }, { embed: table(vectors), guess: async () => 'pantry' })
    expect(out).toEqual([{ outcome: 'skipped', id: filters }]) // the pick itself is left alone
    expect(await rowOf(db, filters)).toEqual({ c: 'coffee', s: 'picked' })
    const papers = await add(db, 'coffee filter papers')
    expect(await autoCategorizeItem(db, { groupId: G, itemId: papers }, { embed: table(vectors), guess: async () => 'pantry' })).toMatchObject({ source: 'similar', category: 'coffee', similarTo: 'coffee filters' })
  })

  it('rename: an AUTOMATIC category is dropped and the row sorted again; a housemate\'s pick is kept; a case-only fix keeps it', async () => {
    const db = await setup()
    const milk = await add(db, 'mlik')
    await db.update(listItems).set({ category: 'pantry', categorySource: 'guessed', categorizedAt: new Date() }).where(eq(listItems.id, milk))
    const renamed = await renameItem(db, { groupId: G, from: 'mlik', to: 'oat milk', renamedBy: null })
    expect(renamed).toMatchObject({ outcome: 'renamed', resortId: milk })
    expect(await rowOf(db, milk)).toEqual({ c: null, s: null })
    await runCategorize(inline, () => db, { groupId: G, itemIds: [renamed.resortId!] }, { embed: table({}), guess: async (i) => (i === 'oat milk' ? 'fresh' : 'pantry') })
    expect(await rowOf(db, milk)).toEqual({ c: 'fresh', s: 'guessed' })

    const beans = await add(db, 'beans')
    await setItemCategory(db, { groupId: G, id: beans, category: 'coffee', by: null })
    const kept = await renameItem(db, { groupId: G, from: 'beans', to: 'coffee beans', renamedBy: null })
    expect(kept.outcome).toBe('renamed')
    expect(kept.resortId).toBeUndefined()
    expect(await rowOf(db, beans)).toEqual({ c: 'coffee', s: 'picked' })

    const caseOnly = await renameItem(db, { groupId: G, from: 'oat milk', to: 'Oat Milk', renamedBy: null })
    expect(caseOnly.resortId).toBeUndefined()
    expect(await rowOf(db, milk)).toEqual({ c: 'fresh', s: 'guessed' })
  })
})
