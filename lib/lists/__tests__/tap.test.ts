import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig, listItems } from '@/db/schema'
import type { Database } from '@/db/client'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember, deactivateMember } from '@/lib/identity/roster'
import { addListItems, liveListRows, toggleListItem } from '@/lib/lists/store'
import { captureOutbound, type OutboundMessage } from '@/lib/telegram/outbox'
import { withSimulatedTime } from '@/lib/core/clock'

// A tap on the live shopping list (issue #25): driven through the REAL callback handler (runCallback →
// runShopTap) with a PGlite house; Telegram is the sandbox outbox (no network), Inngest is captured.

const dbh: { db: Database | null } = { db: null }
vi.mock('@/db/client', async (o) => ({ ...(await o<typeof import('@/db/client')>()), createHttpDb: () => dbh.db }))
const send = vi.fn(async (..._a: unknown[]) => ({ ids: [] as string[] }))
vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, send: (...a: unknown[]) => send(...a), createFunction: (_a: unknown, _b: unknown, h: unknown) => h } }
})

const { runCallback } = await import('@/lib/inngest/functions/callback')
const { STALE_LIST_TOAST } = await import('@/lib/lists/tap')

const HOUSE = '-100tapHouse'
const OTHER = '-100tapOther'
const RYAN = 501
const CHLOE = 502
const STRANGER = 999
const LIVE_ID = 4242
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }

let seq = 0
async function tap(fromId: number, data: string, opts: { chatId?: string; messageId?: number | null; step?: typeof step } = {}) {
  const ev = { data: { callbackId: `cb${++seq}`, fromId, chatId: opts.chatId ?? HOUSE, messageId: opts.messageId === undefined ? LIVE_ID : opts.messageId, data } }
  const { result, sent } = await captureOutbound(() => withSimulatedTime(new Date('2026-10-13T16:05:00Z'), () => runCallback(ev, opts.step ?? step)))
  return { result: result as Record<string, unknown>, sent }
}
const toastOf = (sent: OutboundMessage[]) => sent.find((m) => m.kind === 'callback-answer')?.text ?? null
const renders = () => send.mock.calls.map((c) => c[0] as { name: string; data: Record<string, unknown> }).filter((e) => e.name === 'lists/shopping.render')
const db = () => dbh.db!
const idOf = async (groupId: string, item: string) =>
  (await db().select({ id: listItems.id, item: listItems.item, g: listItems.groupId }).from(listItems)).find((r) => r.item === item && r.g === groupId)!.id
const doneOf = async (id: string) => (await db().select({ c: listItems.checkedAt }).from(listItems).where(eq(listItems.id, id)))[0].c != null

beforeEach(async () => {
  delete process.env.BAUMY_HOUSE_CHAT_ID
  delete process.env.BAUMY_OWNER_ID
  dbh.db = await makeTestDb()
  await ensureRegistered(db(), HOUSE, null)
  await ensureRegistered(db(), OTHER, null)
  await db().insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE, shoppingMessageChatId: HOUSE, shoppingMessageId: LIVE_ID })
  await upsertMember(db(), HOUSE, String(RYAN), 'Ryan', 'owner')
  await upsertMember(db(), HOUSE, String(CHLOE), 'Chloe', 'member')
  await addListItems(db(), { groupId: HOUSE, items: ['Ginger', 'milk'], addedBy: null })
  send.mockReset()
  send.mockResolvedValue({ ids: [] })
})

describe('a tap on an item (shop:chk:<id>)', () => {
  it('ticks it: one toast naming the item and the tapper, the stamp, then a render request (no debounce) focused on the item', async () => {
    const ginger = await idOf(HOUSE, 'Ginger')
    const { result, sent } = await tap(RYAN, `shop:chk:${ginger}`)
    expect(result).toEqual({ toggled: 'ticked' })
    expect(toastOf(sent)).toBe('✓ Ginger – ticked by Ryan')
    expect(await doneOf(ginger)).toBe(true)
    const [cfg] = await db().select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg).toEqual({ by: String(RYAN), at: new Date('2026-10-13T16:05:00Z') })
    expect(renders().map((e) => e.data)).toEqual([{ groupId: HOUSE, reason: 'tap', focusItemId: ginger }])
    // the toast comes before the render
    expect(sent.filter((m) => m.kind !== 'callback-answer')).toEqual([])

    const again = await tap(CHLOE, `shop:chk:${ginger}`)
    expect(toastOf(again.sent)).toBe('↩ Ginger – back on the list by Chloe')
    expect(await doneOf(ginger)).toBe(false)
  })

  it('a NON-member tap is refused before anything is read or changed', async () => {
    const ginger = await idOf(HOUSE, 'Ginger')
    const { result, sent } = await tap(STRANGER, `shop:chk:${ginger}`)
    expect(result).toEqual({ ignored: 'not-member' })
    expect(toastOf(sent)).toBe('Not authorized.')
    expect(await doneOf(ginger)).toBe(false)
    expect(renders()).toEqual([])
    // a member who LEFT the house is not a member any more
    await deactivateMember(db(), String(CHLOE))
    expect((await tap(CHLOE, `shop:chk:${ginger}`)).result).toEqual({ ignored: 'not-member' })
    expect(await doneOf(ginger)).toBe(false)
    // …and the same tap by an active member does tick it (the refusal was about WHO)
    expect((await tap(RYAN, `shop:chk:${ginger}`)).result).toEqual({ toggled: 'ticked' })
  })

  it("another house's item id is refused: nothing changes in either house", async () => {
    await addListItems(db(), { groupId: OTHER, items: ['caviar'], addedBy: null })
    const caviar = await idOf(OTHER, 'caviar')
    const { result, sent } = await tap(RYAN, `shop:chk:${caviar}`)
    expect(result).toEqual({ toggled: 'gone' })
    expect(toastOf(sent)).toBe("That item isn't on the list any more.")
    expect(await doneOf(caviar)).toBe(false)
    const [stamp] = await db().select({ at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(stamp.at).toBeNull() // nothing changed, so no "last updated"
  })

  it('a tap in a chat that is not the house (or on a message that is not the live list) changes nothing', async () => {
    const ginger = await idOf(HOUSE, 'Ginger')
    const elsewhere = await tap(RYAN, `shop:chk:${ginger}`, { chatId: OTHER })
    expect(elsewhere.result).toEqual({ ignored: 'other-chat' })
    expect(toastOf(elsewhere.sent)).toBe('Not authorized.')
    const stale = await tap(RYAN, `shop:chk:${ginger}`, { messageId: LIVE_ID - 1 })
    expect(stale.result).toEqual({ ignored: 'stale-message' })
    expect(toastOf(stale.sent)).toBe(STALE_LIST_TOAST)
    expect(stale.sent.filter((m) => m.kind === 'edit')).toEqual([]) // never edits a message it doesn't own as the list
    expect(await doneOf(ginger)).toBe(false)
    expect(renders()).toEqual([])
  })

  it('malformed or oversized data is answered and dropped; it never reaches the confirm-card parse', async () => {
    for (const data of ['shop:chk:not-a-uuid', 'shop:chk:', `shop:chk:${'a'.repeat(80)}`, 'shop:page:0', 'shop:drop']) {
      const { result, sent } = await tap(RYAN, data)
      expect(result).toEqual({ ignored: 'bad-data' })
      expect(sent).toEqual([expect.objectContaining({ kind: 'callback-answer', text: null })])
    }
    expect((await liveListRows(db(), HOUSE)).every((r) => !r.done)).toBe(true)
  })

  it('re-opening a done item that was re-added since: "already on the list", and the done copy goes', async () => {
    const first = await idOf(HOUSE, 'milk')
    await toggleListItem(db(), { groupId: HOUSE, itemId: first, by: null })
    await addListItems(db(), { groupId: HOUSE, items: ['milk'], addedBy: null })
    const { sent } = await tap(CHLOE, `shop:chk:${first}`)
    expect(toastOf(sent)).toBe('milk is already on the list')
    expect((await liveListRows(db(), HOUSE)).map((r) => [r.item, r.done])).toEqual([
      ['Ginger', false],
      ['milk', false],
    ])
  })

  it('an Inngest retry replays the memoized toggle — the item is ticked ONCE', async () => {
    const ginger = await idOf(HOUSE, 'Ginger')
    const memo = new Map<string, unknown>()
    const memoStep = { run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => (memo.has(id) ? (memo.get(id) as T) : (memo.set(id, await fn()), memo.get(id) as T)) }
    await tap(RYAN, `shop:chk:${ginger}`, { step: memoStep })
    await tap(RYAN, `shop:chk:${ginger}`, { step: memoStep }) // the retry
    expect(await doneOf(ginger)).toBe(true)
  })

  it('if Inngest cannot be reached, the tap renders inline (the tapper still sees the tick)', async () => {
    send.mockRejectedValue(new Error('inngest down'))
    const ginger = await idOf(HOUSE, 'Ginger')
    const { sent } = await tap(RYAN, `shop:chk:${ginger}`)
    const edit = sent.find((m) => m.kind === 'edit')
    expect(edit?.meta).toBe(String(LIVE_ID))
    expect(edit?.keyboard?.flat().map((b) => b.text)).toEqual(['☐ milk', '☑ Ginger', '🧹 Clear done', '🔄 Refresh'])
  })
})

describe('Clear done, Refresh, pages', () => {
  it('Clear done clears the done items (toast with the count), then renders page 1', async () => {
    await toggleListItem(db(), { groupId: HOUSE, itemId: await idOf(HOUSE, 'milk'), by: null })
    const { result, sent } = await tap(CHLOE, 'shop:clear')
    expect(result).toEqual({ cleared: 1 })
    expect(toastOf(sent)).toBe('🧹 Cleared 1 done item')
    expect((await liveListRows(db(), HOUSE)).map((r) => r.item)).toEqual(['Ginger'])
    expect(renders().at(-1)?.data).toEqual({ groupId: HOUSE, reason: 'tap', page: 1 })
    const [cfg] = await db().select({ by: houseConfig.shoppingUpdatedBy }).from(houseConfig)
    expect(cfg.by).toBe(String(CHLOE))
    expect(toastOf((await tap(CHLOE, 'shop:clear')).sent)).toBe('Nothing to clear.')
  })

  it('Refresh and ◀ / ▶ change nothing and render the asked page', async () => {
    expect(toastOf((await tap(RYAN, 'shop:refresh')).sent)).toBe('Up to date.')
    await tap(RYAN, 'shop:page:3')
    expect(renders().map((e) => e.data)).toEqual([
      { groupId: HOUSE, reason: 'tap', page: 1 },
      { groupId: HOUSE, reason: 'tap', page: 3 },
    ])
    const [cfg] = await db().select({ at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg.at).toBeNull()
  })
})
