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

// The kitchen shopping API (lib/lists/kitchen-api.ts): Bearer-token wall, house scope from
// getHouseChatId only, the store's dedupe, and member attribution only for a real active member.

const TOKEN = 'kitchen-token-0123456789abcdef'
const HOUSE = '-100kitchenHouse'
const OTHER = '-100someOtherHouse'
const URL_BASE = 'http://local/api/kitchen/shopping'

function req(path: '' | '/add' | '/checkoff', opts: { body?: unknown; auth?: string | null; method?: string; query?: string } = {}): Request {
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

describe('kitchen shopping API — middleware', () => {
  it('the dashboard session gate never covers the kitchen routes (a kiosk has no cookie)', () => {
    for (const url of [URL_BASE, `${URL_BASE}/add`, `${URL_BASE}/checkoff`]) {
      expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url })).toBe(false)
    }
    expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, url: 'http://local/admin' })).toBe(true)
  })
})
