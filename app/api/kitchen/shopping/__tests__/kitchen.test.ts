import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { __setDbOverride, type Database } from '@/db/client'
import { houseConfig, listItems, telegramChats } from '@/db/schema'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { deactivateMember, upsertMember } from '@/lib/identity/roster'
import { addListItems, currentList } from '@/lib/lists/store'
import { config as middlewareConfig } from '@/middleware'
import { GET } from '@/app/api/kitchen/shopping/route'
import { POST as ADD } from '@/app/api/kitchen/shopping/add/route'
import { POST as CHECKOFF } from '@/app/api/kitchen/shopping/checkoff/route'
import { POST as REMOVE } from '@/app/api/kitchen/shopping/remove/route'
import { POST as RENAME } from '@/app/api/kitchen/shopping/rename/route'

// The shopping-topic repost trigger (docs/spec/shopping-list.md §Shopping topic) — spied, never sent.
const requestShoppingRepost = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/lists/board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lists/board')>()
  return { ...actual, requestShoppingRepost: (...a: unknown[]) => requestShoppingRepost(...a) }
})

// The kitchen shopping API (lib/lists/kitchen-api.ts): Bearer-token wall, house scope from
// getHouseChatId only, the store's dedupe, and member attribution only for a real active member.

const TOKEN = 'kitchen-token-0123456789abcdef'
const HOUSE = '-100kitchenHouse'
const OTHER = '-100someOtherHouse'
const URL_BASE = 'http://local/api/kitchen/shopping'

function req(path: '' | '/add' | '/checkoff' | '/remove' | '/rename', opts: { body?: unknown; auth?: string | null; method?: string; query?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = opts.auth === undefined ? `Bearer ${TOKEN}` : opts.auth
  if (auth !== null) headers.authorization = auth
  return new Request(`${URL_BASE}${path}${opts.query ?? ''}`, {
    method: opts.method ?? (path === '' ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  })
}

async function house(db: Database, id = HOUSE): Promise<void> {
  await ensureRegistered(db, id, null)
  await db.insert(houseConfig).values({ id: true, houseGroupChatId: id }).onConflictDoUpdate({ target: houseConfig.id, set: { houseGroupChatId: id } })
}

const openItems = async (db: Database, groupId: string) => (await currentList(db, groupId)).map((r) => r.item).sort()

let db: Database
beforeEach(async () => {
  db = await makeTestDb()
  __setDbOverride(db)
  vi.stubEnv('KITCHEN_API_TOKEN', TOKEN)
  vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  requestShoppingRepost.mockClear()
})
afterEach(() => {
  __setDbOverride(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('kitchen shopping API — the token wall', () => {
  it('401s without a token, with a wrong one, and with a non-Bearer scheme — and never touches the list', async () => {
    await house(db)
    for (const auth of [null, 'Bearer nope', `Basic ${TOKEN}`, TOKEN, 'Bearer ', `Bearer ${TOKEN}x`]) {
      expect((await GET(req('', { auth }))).status).toBe(401)
      const add = await ADD(req('/add', { auth, body: { items: ['milk'] } }))
      expect(add.status).toBe(401)
      expect(await add.json()).toEqual({ ok: false, error: 'unauthorized' })
      expect((await CHECKOFF(req('/checkoff', { auth, body: { items: ['milk'] } }))).status).toBe(401)
    }
    expect(await openItems(db, HOUSE)).toEqual([])
  })

  it('fails closed when KITCHEN_API_TOKEN is unset — an empty bearer never matches an empty secret', async () => {
    await house(db)
    vi.stubEnv('KITCHEN_API_TOKEN', '')
    expect((await GET(req('', { auth: 'Bearer ' }))).status).toBe(401)
    expect((await GET(req('')))).toHaveProperty('status', 401)
    expect((await ADD(req('/add', { body: { items: ['milk'] } }))).status).toBe(401)
    expect(await openItems(db, HOUSE)).toEqual([])
  })

  it('with the token: 200 and the open items, oldest first', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    await addListItems(db, { groupId: HOUSE, items: ['eggs'], addedBy: null })
    const res = await GET(req('', { auth: `bearer ${TOKEN}` })) // scheme is case-insensitive
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { ok: boolean; items: { id: string; item: string; addedBy: string | null; createdAt: string }[] }
    expect(body.ok).toBe(true)
    expect(body.items.map((i) => i.item)).toEqual(['milk', 'eggs'])
    expect(body.items[0]).toMatchObject({ addedBy: null })
    expect(typeof body.items[0].id).toBe('string')
  })
})

describe('kitchen shopping API — house scoping', () => {
  it('before the bot is in a group: 503 not_configured, and nothing is read or written', async () => {
    // A stray row on some chat must not leak through, and an add must not register anything.
    await ensureRegistered(db, OTHER, null)
    await addListItems(db, { groupId: OTHER, items: ['caviar'], addedBy: null })
    for (const res of [
      await GET(req('')),
      await ADD(req('/add', { body: { items: ['milk'] } })),
      await CHECKOFF(req('/checkoff', { body: { items: ['caviar'] } })),
    ]) {
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ ok: false, error: 'not_configured' })
    }
    expect(await db.select().from(telegramChats)).toHaveLength(1) // only OTHER, registered above
    expect(await openItems(db, OTHER)).toEqual(['caviar'])
    expect(await db.select().from(listItems).where(eq(listItems.item, 'milk'))).toHaveLength(0)
  })

  it('reads and writes ONLY the house scope — a groupId in the request is ignored', async () => {
    await house(db)
    await ensureRegistered(db, OTHER, null)
    await addListItems(db, { groupId: OTHER, items: ['caviar'], addedBy: null })

    const got = (await (await GET(req('', { query: `?groupId=${OTHER}` }))).json()) as { items: unknown[] }
    expect(got.items).toEqual([])

    const add = await ADD(req('/add', { body: { items: ['milk'], groupId: OTHER } }))
    expect(add.status).toBe(200)
    expect(await openItems(db, HOUSE)).toEqual(['milk'])
    expect(await openItems(db, OTHER)).toEqual(['caviar'])

    const off = (await (await CHECKOFF(req('/checkoff', { body: { items: ['caviar'], groupId: OTHER } }))).json()) as { notFound: string[] }
    expect(off.notFound).toEqual(['caviar']) // another house's row is never touched
    expect(await openItems(db, OTHER)).toEqual(['caviar'])
  })

  it('uses the scope id, never the send id, after a group→supergroup migration (live_chat_id set)', async () => {
    const LIVE = '-100migratedLiveId'
    await house(db)
    await ensureRegistered(db, LIVE, null)
    await db.update(houseConfig).set({ liveChatId: LIVE })
    const res = await ADD(req('/add', { body: { items: ['flour'] } }))
    expect(res.status).toBe(200)
    expect(await openItems(db, HOUSE)).toEqual(['flour'])
    expect(await openItems(db, LIVE)).toEqual([])
  })

  it('honours the BAUMY_HOUSE_CHAT_ID pin (the scope id), registering the pinned chat for the FK', async () => {
    const PIN = '-100pinnedScope'
    await house(db) // captured id differs from the pin; the pin wins, as it does for the Telegram lane
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', PIN)
    const res = await ADD(req('/add', { body: { items: ['bin bags'] } }))
    expect(res.status).toBe(200)
    expect(await openItems(db, PIN)).toEqual(['bin bags'])
    expect(await openItems(db, HOUSE)).toEqual([])
    expect(((await (await GET(req(''))).json()) as { items: { item: string }[] }).items.map((i) => i.item)).toEqual(['bin bags'])
  })
})

describe('kitchen shopping API — add and check off', () => {
  it('adding an item that is already open is a no-op: one open row, reported as already', async () => {
    await house(db)
    const first = (await (await ADD(req('/add', { body: { items: ['Oat Milk', 'coffee'] } }))).json()) as Record<string, unknown>
    expect(first).toMatchObject({ ok: true, already: [], attributedTo: null })
    expect([...(first.added as string[])].sort()).toEqual(['Oat Milk', 'coffee'].sort())

    const again = (await (await ADD(req('/add', { body: { items: ['oat milk', '  OAT  MILK '] } }))).json()) as Record<string, unknown>
    expect(again).toMatchObject({ ok: true, added: [], already: ['oat milk'] })
    const rows = await db
      .select()
      .from(listItems)
      .where(and(eq(listItems.groupId, HOUSE), eq(listItems.itemNormalized, 'oat milk'), isNull(listItems.checkedAt)))
    expect(rows).toHaveLength(1)
    expect((again.items as { item: string }[]).map((i) => i.item).sort()).toEqual(['Oat Milk', 'coffee'].sort())
  })

  it('checks items off; the open list drops them; a miss is reported', async () => {
    await house(db)
    await ADD(req('/add', { body: { items: ['milk', 'eggs', 'bin bags'] } }))
    const res = (await (await CHECKOFF(req('/checkoff', { body: { items: ['milk', 'the eggs', 'nutmeg'] } }))).json()) as Record<string, unknown>
    expect(res).toMatchObject({ ok: true, notFound: ['nutmeg'], attributedTo: null })
    expect([...(res.checkedOff as string[])].sort()).toEqual(['eggs', 'milk'])
    expect((res.items as { item: string }[]).map((i) => i.item)).toEqual(['bin bags'])
    const [milk] = await db.select().from(listItems).where(eq(listItems.item, 'milk'))
    expect(milk.checkedAt).not.toBeNull()
    expect(milk.checkedBy).toBeNull()
  })

  it('attributes to an ACTIVE member only; an unknown or deactivated id is attributed to nobody', async () => {
    await house(db)
    await upsertMember(db, HOUSE, '702', 'Marco')
    await upsertMember(db, HOUSE, '704', 'Gone')
    await deactivateMember(db, '704')

    const a = (await (await ADD(req('/add', { body: { items: ['milk'], telegramUserId: 702 } }))).json()) as Record<string, unknown>
    expect(a.attributedTo).toBe('702')
    const b = (await (await ADD(req('/add', { body: { items: ['eggs'], telegramUserId: '999999' } }))).json()) as Record<string, unknown>
    expect(b.attributedTo).toBeNull()
    const c = (await (await ADD(req('/add', { body: { items: ['tea'], telegramUserId: '704' } }))).json()) as Record<string, unknown>
    expect(c.attributedTo).toBeNull()
    const byItem = new Map((await currentList(db, HOUSE)).map((r) => [r.item, r.addedBy]))
    expect(byItem).toEqual(new Map([['milk', '702'], ['eggs', null], ['tea', null]]))

    const off = (await (await CHECKOFF(req('/checkoff', { body: { items: ['milk'], telegramUserId: '702' } }))).json()) as Record<string, unknown>
    expect(off.attributedTo).toBe('702')
    const [milk] = await db.select().from(listItems).where(eq(listItems.item, 'milk'))
    expect(milk.checkedBy).toBe('702')
  })

  it('400s a malformed write and changes nothing', async () => {
    await house(db)
    for (const body of ['not json', {}, { items: [] }, { items: 'milk' }, { items: [1] }, { items: ['milk'], telegramUserId: 'marco' }, { items: Array(31).fill('x') }]) {
      const res = await ADD(req('/add', { body }))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, error: 'bad_request' })
      expect((await CHECKOFF(req('/checkoff', { body }))).status).toBe(400)
    }
    expect(await openItems(db, HOUSE)).toEqual([])
  })
})

describe('kitchen shopping API — the shopping-topic repost (issue #21)', () => {
  it('an add that put something on the list asks for the debounced repost, for the house scope', async () => {
    await house(db)
    expect((await ADD(req('/add', { body: { items: ['milk'] } }))).status).toBe(200)
    expect(requestShoppingRepost).toHaveBeenCalledTimes(1)
    expect(requestShoppingRepost).toHaveBeenCalledWith(HOUSE)
  })

  it('a check-off that ticked something asks for the repost', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    expect((await CHECKOFF(req('/checkoff', { body: { items: ['milk'] } }))).status).toBe(200)
    expect(requestShoppingRepost).toHaveBeenCalledTimes(1)
    expect(requestShoppingRepost).toHaveBeenCalledWith(HOUSE)
  })

  it('a write that changed nothing, a read, a refused or a malformed request asks for none', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    expect((await ADD(req('/add', { body: { items: ['milk'] } }))).status).toBe(200) // already open
    expect((await CHECKOFF(req('/checkoff', { body: { items: ['caviar'] } }))).status).toBe(200) // not on it
    expect((await GET(req(''))).status).toBe(200)
    expect((await ADD(req('/add', { auth: 'Bearer nope', body: { items: ['eggs'] } }))).status).toBe(401)
    expect((await ADD(req('/add', { body: { items: [] } }))).status).toBe(400)
    expect(requestShoppingRepost).not.toHaveBeenCalled()
  })
})

describe('kitchen shopping API — middleware', () => {
  it('the dashboard session gate never covers the kitchen routes (a kiosk has no cookie)', () => {
    for (const url of [URL_BASE, `${URL_BASE}/add`, `${URL_BASE}/checkoff`, `${URL_BASE}/remove`, `${URL_BASE}/rename`]) {
      expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url })).toBe(false)
    }
    expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url: 'http://local/admin' })).toBe(true)
  })
})

// Issue #23: remove WITHOUT buying, and rename — same token wall, scope, attribution and repost rule.
describe('kitchen shopping API — remove and rename (issue #23)', () => {
  it('401s without the right token and 503s before a house exists — the list is never touched', async () => {
    await ensureRegistered(db, OTHER, null)
    await addListItems(db, { groupId: OTHER, items: ['milk'], addedBy: null })
    expect((await REMOVE(req('/remove', { body: { items: ['milk'] } }))).status).toBe(503)
    expect((await RENAME(req('/rename', { body: { from: 'milk', to: 'oat milk' } }))).status).toBe(503)
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    for (const auth of [null, 'Bearer nope', `Basic ${TOKEN}`]) {
      const r = await REMOVE(req('/remove', { auth, body: { items: ['milk'] } }))
      expect(r.status).toBe(401)
      expect(await r.json()).toEqual({ ok: false, error: 'unauthorized' })
      expect((await RENAME(req('/rename', { auth, body: { from: 'milk', to: 'oat milk' } }))).status).toBe(401)
    }
    expect(await openItems(db, HOUSE)).toEqual(['milk'])
    expect(await openItems(db, OTHER)).toEqual(['milk'])
    expect(requestShoppingRepost).not.toHaveBeenCalled()
  })

  it('400s a malformed body and changes nothing', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    for (const body of ['not json', {}, { items: [] }, { items: 'milk' }, { items: ['milk'], telegramUserId: 'marco' }]) {
      const res = await REMOVE(req('/remove', { body }))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, error: 'bad_request' })
    }
    for (const body of ['not json', {}, { from: 'milk' }, { to: 'oat milk' }, { from: 'milk', to: '   ' }, { from: '', to: 'x' }, { from: 'milk', to: 2 }, { from: 'milk', to: 'x'.repeat(201) }]) {
      const res = await RENAME(req('/rename', { body }))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, error: 'bad_request' })
    }
    expect(await openItems(db, HOUSE)).toEqual(['milk'])
    expect(requestShoppingRepost).not.toHaveBeenCalled()
  })

  it('remove: soft, attributed to an active member only, reports misses, and only the house scope', async () => {
    await house(db)
    await upsertMember(db, HOUSE, '702', 'Marco')
    await ensureRegistered(db, OTHER, null)
    await addListItems(db, { groupId: OTHER, items: ['eggs'], addedBy: null })
    await addListItems(db, { groupId: HOUSE, items: ['milk', 'eggs', 'tea'], addedBy: null })
    const res = await REMOVE(req('/remove', { body: { items: ['milk', 'nutmeg'], telegramUserId: 702, groupId: OTHER } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, removed: ['milk'], notFound: ['nutmeg'], attributedTo: '702' })
    expect((body.items as { item: string }[]).map((i) => i.item)).toEqual(['eggs', 'tea'])
    const [milk] = await db.select().from(listItems).where(eq(listItems.item, 'milk'))
    expect(milk).toMatchObject({ isActive: false, removedBy: '702', checkedAt: null, checkedBy: null })
    // an unknown id is attributed to nobody
    const anon = (await (await REMOVE(req('/remove', { body: { items: ['tea'], telegramUserId: '999' } }))).json()) as Record<string, unknown>
    expect(anon).toMatchObject({ removed: ['tea'], attributedTo: null })
    const [tea] = await db.select().from(listItems).where(eq(listItems.item, 'tea'))
    expect(tea.removedBy).toBeNull()
    expect(await openItems(db, OTHER)).toEqual(['eggs'])
  })

  it('rename: renamed, merged, unchanged and not_found, attributed, house scope only', async () => {
    await house(db)
    await upsertMember(db, HOUSE, '702', 'Marco')
    await ensureRegistered(db, OTHER, null)
    await addListItems(db, { groupId: OTHER, items: ['mlik'], addedBy: null })
    await addListItems(db, { groupId: HOUSE, items: ['mlik', 'bred', 'bread'], addedBy: null })

    const a = (await (await RENAME(req('/rename', { body: { from: 'mlik', to: 'milk', telegramUserId: '702', groupId: OTHER } }))).json()) as Record<string, unknown>
    expect(a).toMatchObject({ ok: true, outcome: 'renamed', from: 'mlik', to: 'milk', attributedTo: '702' })
    expect((a.items as { item: string }[]).map((i) => i.item).sort()).toEqual(['bread', 'bred', 'milk'])
    const [milk] = await db.select().from(listItems).where(and(eq(listItems.groupId, HOUSE), eq(listItems.item, 'milk')))
    expect(milk.renamedBy).toBe('702')
    expect(await openItems(db, OTHER)).toEqual(['mlik']) // another house's row is never touched

    const b = (await (await RENAME(req('/rename', { body: { from: 'bred', to: 'Bread' } }))).json()) as Record<string, unknown>
    expect(b).toMatchObject({ ok: true, outcome: 'merged', from: 'bred', to: 'bread', attributedTo: null })
    expect(await openItems(db, HOUSE)).toEqual(['bread', 'milk'])

    expect(await (await RENAME(req('/rename', { body: { from: 'milk', to: 'milk' } }))).json()).toMatchObject({ outcome: 'unchanged', from: 'milk', to: 'milk' })
    expect(await (await RENAME(req('/rename', { body: { from: 'nutmeg', to: 'mace' } }))).json()).toMatchObject({ ok: true, outcome: 'not_found', from: 'nutmeg' })
    expect(await openItems(db, HOUSE)).toEqual(['bread', 'milk'])
  })

  it('an ambiguous name is reported apart from not found, names its matches, and changes nothing', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['sponge', 'sponges'], addedBy: null })
    const rm = (await (await REMOVE(req('/remove', { body: { items: ['a sponge', 'nutmeg'] } }))).json()) as Record<string, unknown>
    expect(rm).toMatchObject({ ok: true, removed: [], notFound: ['nutmeg'] })
    expect(rm.ambiguous).toEqual([{ item: 'a sponge', matches: expect.arrayContaining(['sponge', 'sponges']) }])
    const rn = (await (await RENAME(req('/rename', { body: { from: 'a sponge', to: 'scourer' } }))).json()) as Record<string, unknown>
    expect(rn).toMatchObject({ ok: true, outcome: 'ambiguous', from: 'a sponge', to: 'scourer' })
    expect([...(rn.matches as string[])].sort()).toEqual(['sponge', 'sponges'])
    // a plain not_found carries no matches
    expect(await (await RENAME(req('/rename', { body: { from: 'nutmeg', to: 'mace' } }))).json()).not.toHaveProperty('matches')
    expect(await openItems(db, HOUSE)).toEqual(['sponge', 'sponges'])
    expect(requestShoppingRepost).not.toHaveBeenCalled()
  })

  it('asks for the repost ONLY when the list changed', async () => {
    await house(db)
    await addListItems(db, { groupId: HOUSE, items: ['milk', 'mlik', 'tea'], addedBy: null })
    // changed nothing → no repost
    expect((await REMOVE(req('/remove', { body: { items: ['caviar'] } }))).status).toBe(200)
    expect((await RENAME(req('/rename', { body: { from: 'caviar', to: 'roe' } }))).status).toBe(200)
    expect((await RENAME(req('/rename', { body: { from: 'tea', to: 'tea' } }))).status).toBe(200)
    expect(requestShoppingRepost).not.toHaveBeenCalled()
    // each change → one repost request for the house scope
    await REMOVE(req('/remove', { body: { items: ['tea'] } }))
    expect(requestShoppingRepost).toHaveBeenCalledTimes(1)
    await RENAME(req('/rename', { body: { from: 'milk', to: 'oat milk' } }))
    expect(requestShoppingRepost).toHaveBeenCalledTimes(2)
    await RENAME(req('/rename', { body: { from: 'mlik', to: 'oat milk' } })) // merged
    expect(requestShoppingRepost).toHaveBeenCalledTimes(3)
    for (const c of requestShoppingRepost.mock.calls) expect(c).toEqual([HOUSE])
  })
})
