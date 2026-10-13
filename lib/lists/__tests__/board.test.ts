import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig } from '@/db/schema'
import type { Database } from '@/db/client'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { withSimulatedTime } from '@/lib/core/clock'

// The live list's change signal and take-down (docs/spec/shopping-list.md §Live list, issue #25): every
// list write stamps "last updated" and sends the debounced change event; /shoppingoff unpins and takes
// the live message down. (The render itself: render.test.ts; the pure half: live.test.ts.)

const deleteMessage = vi.fn(async (..._a: unknown[]) => true)
const editShoppingBoard = vi.fn(async (..._a: unknown[]) => true)
const unpinMessage = vi.fn(async (..._a: unknown[]) => true)
vi.mock('@/lib/telegram/client', () => ({
  deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  editShoppingBoard: (...a: unknown[]) => editShoppingBoard(...a),
  unpinMessage: (...a: unknown[]) => unpinMessage(...a),
}))
const send = vi.fn(async (..._a: unknown[]) => ({ ids: [] as string[] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }))

const { noteShoppingChange, requestShoppingRefresh, requestShoppingRefreshForHouse, retireShoppingBoard, isTopicGone, NO_LONGER_UPDATED, SHOPPING_CHANGED } =
  await import('@/lib/lists/board')

const HOUSE = '-100boardHouse'
let db: Database

beforeEach(async () => {
  db = await makeTestDb()
  await ensureRegistered(db, HOUSE, null)
  await db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
  await upsertMember(db, HOUSE, '501', 'Ryan', 'owner')
  send.mockReset()
  send.mockResolvedValue({ ids: [] })
  for (const f of [deleteMessage, editShoppingBoard, unpinMessage]) f.mockReset()
  deleteMessage.mockResolvedValue(true)
  editShoppingBoard.mockResolvedValue(true)
  unpinMessage.mockResolvedValue(true)
})

describe('noteShoppingChange — after every list write that changed something', () => {
  it('stamps who and when, then sends lists/shopping.changed for the house with NO event id', async () => {
    const at = new Date('2026-10-13T16:05:00Z')
    await withSimulatedTime(at, () => noteShoppingChange(db, HOUSE, '501'))
    const [cfg] = await db.select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg).toEqual({ by: '501', at })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toEqual({ name: SHOPPING_CHANGED, data: { groupId: HOUSE } })
    expect(send.mock.calls[0][0]).not.toHaveProperty('id') // an id would dedupe every later change away
  })

  it('is best-effort: a failed stamp or a failed hand-off is logged, never thrown into the list write', async () => {
    send.mockRejectedValue(new Error('401 Event key not found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = new Proxy(db, { get: (t, k) => (k === 'update' ? () => { throw new Error('db down') } : Reflect.get(t, k)) })
    await expect(noteShoppingChange(broken, HOUSE, '501')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('no scope → nothing', async () => {
    await noteShoppingChange(db, '', '501')
    await requestShoppingRefresh('')
    expect(send).not.toHaveBeenCalled()
  })

  it('after /resume: the change signal for the HOUSE scope, without a stamp', async () => {
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
    await requestShoppingRefreshForHouse(db)
    expect(send).toHaveBeenCalledWith({ name: SHOPPING_CHANGED, data: { groupId: HOUSE } })
    const [cfg] = await db.select({ at: houseConfig.shoppingUpdatedAt }).from(houseConfig)
    expect(cfg.at).toBeNull()
    vi.unstubAllEnvs()
  })
})

describe('retireShoppingBoard — /shoppingoff', () => {
  const stored = async () => (await db.select({ chat: houseConfig.shoppingMessageChatId, id: houseConfig.shoppingMessageId }).from(houseConfig))[0]

  it('clears the stored id, unpins the live message, deletes it', async () => {
    await db.update(houseConfig).set({ shoppingMessageChatId: HOUSE, shoppingMessageId: 101 })
    expect(await retireShoppingBoard(db)).toBe('deleted')
    expect(unpinMessage).toHaveBeenCalledWith(HOUSE, 101)
    expect(deleteMessage).toHaveBeenCalledWith(HOUSE, 101)
    expect(await stored()).toEqual({ chat: null, id: null })
    expect(await retireShoppingBoard(db)).toBe('none') // nothing left to take down
    expect(deleteMessage).toHaveBeenCalledTimes(1)
  })

  it('a refused delete marks it "This list is no longer updated." (buttons gone); a refused unpin changes nothing', async () => {
    await db.update(houseConfig).set({ shoppingMessageChatId: HOUSE, shoppingMessageId: 101 })
    deleteMessage.mockResolvedValue(false)
    unpinMessage.mockResolvedValue(false)
    expect(await retireShoppingBoard(db)).toBe('edited')
    expect(editShoppingBoard).toHaveBeenCalledWith(HOUSE, 101, NO_LONGER_UPDATED)
    expect(NO_LONGER_UPDATED).toBe('This list is no longer updated.')
    expect((await stored()).id).toBeNull()
  })
})

describe('isTopicGone', () => {
  it('knows Telegram’s "the topic is gone" answers, and nothing else', () => {
    for (const d of ['Bad Request: message thread not found', 'Bad Request: TOPIC_CLOSED', 'Bad Request: TOPIC_DELETED', 'Bad Request: TOPIC_ID_INVALID'])
      expect(isTopicGone({ description: d })).toBe(true)
    expect(isTopicGone({ description: 'Too Many Requests: retry after 5' })).toBe(false)
    expect(isTopicGone(null)).toBe(false)
  })
})
