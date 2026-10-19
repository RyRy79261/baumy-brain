import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { auditLog, houseConfig } from '@/db/schema'
import type { Database } from '@/db/client'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { addListItems, markShoppingUpdated } from '@/lib/lists/store'
import { setGlobalEnabled } from '@/lib/policy'
import { withSimulatedTime } from '@/lib/core/clock'

// The live list render (issue #25, docs/spec/shopping-list.md §Live list): edit the one live message in
// place; post (and pin silently) only for /list or /shoppinghere with none yet, for /shoppinghere moving
// it, or when the stored message is gone. Telegram is mocked so each refusal can be played.

const sendLiveList = vi.fn(async (..._a: unknown[]) => 7001)
const editLiveList = vi.fn(async (..._a: unknown[]): Promise<'edited' | 'unchanged' | 'gone'> => 'edited')
const pinMessage = vi.fn(async (..._a: unknown[]) => true)
const unpinMessage = vi.fn(async (..._a: unknown[]) => true)
const deleteMessage = vi.fn(async (..._a: unknown[]) => true)
const editShoppingBoard = vi.fn(async (..._a: unknown[]) => true)
const postMessage = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({
  sendLiveList: (...a: unknown[]) => sendLiveList(...a),
  editLiveList: (...a: unknown[]) => editLiveList(...a),
  pinMessage: (...a: unknown[]) => pinMessage(...a),
  unpinMessage: (...a: unknown[]) => unpinMessage(...a),
  deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  editShoppingBoard: (...a: unknown[]) => editShoppingBoard(...a),
  postMessage: (...a: unknown[]) => postMessage(...a),
  sendShoppingBoard: async () => 0,
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async () => ({ ids: [] }) } }))

const { runShoppingRender, messageLink, LIVE_ELSEWHERE, NO_LONGER_UPDATED } = await import('@/lib/lists/board')
const { RetryAfterError } = await import('inngest')

const HOUSE = '-100renderHouse'
const TOPIC = 55
const OTHER_TOPIC = 77
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
let db: Database

const stored = async () =>
  (await db.select({ chat: houseConfig.shoppingMessageChatId, id: houseConfig.shoppingMessageId, thread: houseConfig.shoppingThreadId }).from(houseConfig))[0]
const setStored = (id: number | null, thread: number | null = TOPIC) =>
  db.update(houseConfig).set({ shoppingMessageChatId: id == null ? null : HOUSE, shoppingMessageId: id, shoppingThreadId: thread })
const render = (req: Partial<Parameters<typeof runShoppingRender>[2]> = {}, s: typeof step = step) =>
  withSimulatedTime(new Date('2026-10-13T16:05:00Z'), () => runShoppingRender(s, () => db, { groupId: HOUSE, reason: 'change', ...req }))

beforeEach(async () => {
  delete process.env.BAUMY_HOUSE_CHAT_ID
  process.env.BAUMY_TIMEZONE = 'Europe/Berlin'
  db = await makeTestDb()
  await ensureRegistered(db, HOUSE, null)
  await db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
  await upsertMember(db, HOUSE, '501', 'Ryan', 'owner')
  for (const f of [sendLiveList, editLiveList, pinMessage, unpinMessage, deleteMessage, editShoppingBoard, postMessage]) f.mockClear()
  sendLiveList.mockResolvedValue(7001)
  editLiveList.mockResolvedValue('edited')
  pinMessage.mockResolvedValue(true)
  deleteMessage.mockResolvedValue(true)
})

describe('an ordinary change: edit in place, never a new post', () => {
  it('edits the stored live message with the rendered text and keyboard', async () => {
    await setStored(6000)
    await addListItems(db, { groupId: HOUSE, items: ['Ginger'], addedBy: null })
    await withSimulatedTime(new Date('2026-10-13T16:05:00Z'), () => markShoppingUpdated(db, '501'))
    expect(await render()).toEqual({ status: 'edited', messageId: 6000, pinned: null, pointer: false })
    expect(editLiveList).toHaveBeenCalledTimes(1)
    const [chat, id, text, keyboard] = editLiveList.mock.calls[0] as [string, number, string, { text: string }[][]]
    expect([chat, id]).toEqual([HOUSE, 6000])
    expect(text).toBe('🛒 Shopping list\n1 to buy\nLast updated by Ryan, Tue 13 Oct, 18:05')
    expect(keyboard.flat().map((b) => b.text)).toEqual(['── Not sorted ──', '☐ Ginger', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
    expect(sendLiveList).not.toHaveBeenCalled()
    expect(pinMessage).not.toHaveBeenCalled()
  })

  it('"message is not modified" is a success', async () => {
    await setStored(6000)
    editLiveList.mockResolvedValue('unchanged')
    expect(await render()).toMatchObject({ status: 'unchanged', messageId: 6000 })
    expect(sendLiveList).not.toHaveBeenCalled()
  })

  it('no live message yet → nothing (a change never posts one)', async () => {
    await db.update(houseConfig).set({ shoppingThreadId: TOPIC }) // a topic, but no live message
    await addListItems(db, { groupId: HOUSE, items: ['Ginger'], addedBy: null })
    expect(await render()).toEqual({ status: 'no-message' })
    expect(sendLiveList).not.toHaveBeenCalled()
    expect(editLiveList).not.toHaveBeenCalled()
  })

  it('the message is gone → ONE new post where the list lived, pinned silently, its id stored', async () => {
    await setStored(6000, TOPIC)
    editLiveList.mockResolvedValue('gone')
    expect(await render()).toEqual({ status: 'posted', messageId: 7001, pinned: true, previous: 'none' })
    expect(sendLiveList).toHaveBeenCalledTimes(1)
    expect(sendLiveList.mock.calls[0][0]).toBe(HOUSE)
    expect(sendLiveList.mock.calls[0][3]).toBe(TOPIC)
    expect(pinMessage).toHaveBeenCalledWith(HOUSE, 7001)
    expect(await stored()).toEqual({ chat: HOUSE, id: 7001, thread: TOPIC })
    expect(deleteMessage).not.toHaveBeenCalled() // nothing to retire: it was gone
  })

  it('a pin refused (Baumy lacks the "Pin messages" right) never breaks posting', async () => {
    await setStored(6000)
    editLiveList.mockResolvedValue('gone')
    pinMessage.mockResolvedValue(false)
    expect(await render()).toMatchObject({ status: 'posted', messageId: 7001, pinned: false })
    expect((await stored()).id).toBe(7001)
  })

  it('a re-post into a topic that was deleted clears the topic and the message (audited), no throw', async () => {
    await setStored(6000, TOPIC)
    editLiveList.mockResolvedValue('gone')
    sendLiveList.mockRejectedValue(Object.assign(new Error('Bad Request: message thread not found'), { description: 'Bad Request: message thread not found' }))
    expect(await render()).toEqual({ status: 'topic-gone' })
    expect(await stored()).toEqual({ chat: null, id: null, thread: null })
    const audit = await db.select().from(auditLog)
    expect(audit.map((a) => a.action)).toContain('shopping.topic.cleared')
  })

  it('held while paused — but a tap still renders', async () => {
    await setStored(6000)
    await setGlobalEnabled(db, false)
    expect(await render()).toEqual({ status: 'paused' })
    expect(editLiveList).not.toHaveBeenCalled()
    expect(await render({ reason: 'tap' })).toMatchObject({ status: 'edited' })
  })

  it('another scope is never rendered', async () => {
    await setStored(6000)
    expect(await render({ groupId: '-100elsewhere' })).toEqual({ status: 'other-house' })
    expect(editLiveList).not.toHaveBeenCalled()
  })

  it('a 429 comes back as RetryAfterError with Telegram’s wait', async () => {
    await setStored(6000)
    editLiveList.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: 7 } }))
    const err = await render().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetryAfterError)
    expect((err as InstanceType<typeof RetryAfterError>).retryAfter).toBe('7') // seconds
  })

  it('a re-post that lost a race to /shoppingoff (the stored id changed meanwhile) posts nothing', async () => {
    await setStored(6000)
    editLiveList.mockImplementation(async () => {
      await setStored(null, null) // /shoppingoff landed between the edit and the re-post
      return 'gone'
    })
    expect(await render()).toEqual({ status: 'superseded' })
    expect(sendLiveList).not.toHaveBeenCalled()
  })

  it('a post whose compare-and-set loses is taken down again (never two live lists)', async () => {
    await setStored(6000)
    editLiveList.mockResolvedValue('gone')
    sendLiveList.mockImplementation(async () => {
      await setStored(6500) // another path stored a list while this one was posting
      return 7001
    })
    expect(await render()).toEqual({ status: 'superseded' })
    expect(deleteMessage).toHaveBeenCalledWith(HOUSE, 7001)
    expect((await stored()).id).toBe(6500)
  })
})

describe('renders never send stale text (Inngest limits concurrent STEPS, not runs)', () => {
  const lastEditText = () => (editLiveList.mock.calls.at(-1) as [string, number, string])[2]

  it('A starts first, B runs and edits with a newer list, A edits LAST — A still carries the newest list', async () => {
    await setStored(6000)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    // A is scheduled first but its step only executes after B's: the order "load A, load B, edit B,
    // edit A" of the old two-step render. Each step now reads the list AND edits in one go.
    let releaseA!: () => void
    const gate = new Promise<void>((r) => (releaseA = r))
    // (A step that only READS — the old design's 'live-load' — runs at once; any step that sends waits.)
    const stepA = { run: async <T>(id: string, fn: () => Promise<T>) => (id === 'live-load' ? fn() : (await gate, fn())) }
    const a = render({}, stepA)
    await addListItems(db, { groupId: HOUSE, items: ['eggs'], addedBy: null }) // the list changes…
    await render() // …B renders it…
    expect(lastEditText()).toContain('2 to buy')
    await addListItems(db, { groupId: HOUSE, items: ['tea'], addedBy: null }) // …and changes again
    releaseA()
    expect(await a).toMatchObject({ status: 'edited' })
    expect(editLiveList).toHaveBeenCalledTimes(2)
    expect(lastEditText()).toContain('3 to buy') // the LAST edit is the newest list, never A's old view
    const labels = (editLiveList.mock.calls.at(-1) as [string, number, string, { text: string }[][]])[3].flat().map((b) => b.text)
    expect(labels).toEqual(['── Not sorted ──', '☐ milk', '☐ eggs', '☐ tea', '🗂 Groups', '🧹 Clear done', '🔄 Refresh'])
  })

  it('a 429 retry rebuilds the text: the retried edit carries the list as it is THEN', async () => {
    await setStored(6000)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    // Inngest's replay: a COMPLETED step's result is memoized; the failed one runs again.
    const memo = new Map<string, unknown>()
    const memoStep = { run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => (memo.has(id) ? (memo.get(id) as T) : (memo.set(id, await fn()), memo.get(id) as T)) }
    editLiveList.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: 1 } }))
    await expect(render({}, memoStep)).rejects.toBeInstanceOf(RetryAfterError)
    await addListItems(db, { groupId: HOUSE, items: ['eggs'], addedBy: null }) // changed while waiting
    await render({}, memoStep) // the retry: the edit's step reads the list again (no memoized stale view)
    expect(lastEditText()).toContain('2 to buy')
  })
})

describe('compare-and-set on the live message id (never overwrite /shoppingoff)', () => {
  it('a render whose message was cleared before the edit does not edit it', async () => {
    await setStored(6000)
    const view = vi.spyOn(await import('@/lib/lists/store'), 'liveListRows')
    view.mockImplementationOnce(async () => {
      await setStored(null, null) // /shoppingoff lands while the view is being built
      return []
    })
    expect(await render()).toEqual({ status: 'superseded' })
    expect(editLiveList).not.toHaveBeenCalled()
    view.mockRestore()
  })

  it('/shoppingoff landing DURING the edit: its "no longer updated" marker is put back over the live list', async () => {
    await setStored(6000)
    editLiveList.mockImplementationOnce(async () => {
      await setStored(null, null) // the id is cleared and the message marked while the edit was in flight
      return 'edited'
    })
    expect(await render()).toEqual({ status: 'superseded' })
    expect(editShoppingBoard).toHaveBeenCalledWith(HOUSE, 6000, NO_LONGER_UPDATED)
    expect(editShoppingBoard.mock.invocationCallOrder[0]).toBeGreaterThan(editLiveList.mock.invocationCallOrder[0])
  })
})

describe('/list and /shoppinghere (a place)', () => {
  const list = (threadId: number | null, move = false) => render({ reason: 'command', place: { chatId: HOUSE, threadId, move } })

  it('/list with none yet: posts here (this topic), pins it silently, stores it with the topic', async () => {
    expect(await list(TOPIC)).toEqual({ status: 'posted', messageId: 7001, pinned: true, previous: 'none' })
    expect(sendLiveList.mock.calls[0][3]).toBe(TOPIC)
    expect(await stored()).toEqual({ chat: HOUSE, id: 7001, thread: TOPIC })
  })

  it('/list in General with none yet: posts in General (no topic)', async () => {
    await list(null)
    expect(sendLiveList.mock.calls[0][3]).toBeNull()
    expect(await stored()).toEqual({ chat: HOUSE, id: 7001, thread: null })
  })

  it('/list where the list already is: re-renders (edit) and makes sure it is pinned — no second message', async () => {
    await setStored(6000, TOPIC)
    expect(await list(TOPIC)).toEqual({ status: 'edited', messageId: 6000, pinned: true, pointer: false })
    expect(sendLiveList).not.toHaveBeenCalled()
    expect(pinMessage).toHaveBeenCalledWith(HOUSE, 6000)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('/list somewhere else: the list stays where it is (re-rendered) and Baumy says where it is pinned', async () => {
    await setStored(6000, TOPIC)
    expect(await list(null)).toEqual({ status: 'edited', messageId: 6000, pinned: true, pointer: true })
    expect(sendLiveList).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(HOUSE, LIVE_ELSEWHERE(messageLink(HOUSE, 6000)), { threadId: undefined })
    // a supergroup message gets a link; a basic group (or this test's made-up id) has none
    expect(LIVE_ELSEWHERE(messageLink('-1001234567890', 6000))).toBe('🛒 The live shopping list is pinned here: https://t.me/c/1234567890/6000')
    expect(messageLink('-123456', 6000)).toBeNull()
    expect(LIVE_ELSEWHERE(messageLink(HOUSE, 6000))).toBe('🛒 The live shopping list is pinned in the group.')
  })

  it('/list when the stored message was deleted: a new one here replaces it', async () => {
    await setStored(6000, TOPIC)
    editLiveList.mockResolvedValue('gone')
    expect(await list(OTHER_TOPIC)).toMatchObject({ status: 'posted', messageId: 7001 })
    expect(await stored()).toEqual({ chat: HOUSE, id: 7001, thread: OTHER_TOPIC })
  })

  it('/shoppinghere in another topic MOVES it: new post here, pinned; the old one unpinned and deleted', async () => {
    await setStored(6000, TOPIC)
    expect(await list(OTHER_TOPIC, true)).toEqual({ status: 'posted', messageId: 7001, pinned: true, previous: 'deleted' })
    expect(editLiveList).not.toHaveBeenCalled()
    expect(unpinMessage).toHaveBeenCalledWith(HOUSE, 6000)
    expect(deleteMessage).toHaveBeenCalledWith(HOUSE, 6000)
    expect(await stored()).toEqual({ chat: HOUSE, id: 7001, thread: OTHER_TOPIC })
  })

  it('/shoppinghere moving it, when Telegram refuses the delete: the old one is edited to "no longer updated" (keyboard gone)', async () => {
    await setStored(6000, TOPIC)
    deleteMessage.mockResolvedValue(false)
    expect(await list(OTHER_TOPIC, true)).toMatchObject({ previous: 'edited' })
    expect(editShoppingBoard).toHaveBeenCalledWith(HOUSE, 6000, NO_LONGER_UPDATED)
  })

  it('/shoppinghere where it already is: an edit, not a move', async () => {
    await setStored(6000, TOPIC)
    expect(await list(TOPIC, true)).toMatchObject({ status: 'edited', messageId: 6000 })
    expect(sendLiveList).not.toHaveBeenCalled()
  })

  it('a place that is not the house is refused', async () => {
    expect(await render({ reason: 'command', place: { chatId: '-100stranger', threadId: null, move: false } })).toEqual({ status: 'other-house' })
    expect(sendLiveList).not.toHaveBeenCalled()
  })

  it('/list works while paused (a command, not a proactive post)', async () => {
    await setGlobalEnabled(db, false)
    expect(await list(TOPIC)).toMatchObject({ status: 'posted' })
  })
})
