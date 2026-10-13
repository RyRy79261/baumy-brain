import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { auditLog, houseConfig } from '@/db/schema'
import type { Database } from '@/db/client'
import { ensureRegistered } from '@/lib/memory/write'
import { resolveHouseIds, setShoppingThread } from '@/lib/identity/house'
import { addListItems } from '@/lib/lists/store'
import { setGlobalEnabled } from '@/lib/policy'

// The shopping topic (docs/spec/shopping-list.md §Shopping topic, issue #21): the board text (plain,
// one item per line, untrusted item text defanged), and the repost — post the whole list in the topic,
// store its id, delete the previous one, edit it when the delete is refused, nothing without a topic.

const sendShoppingBoard = vi.fn(async (..._a: unknown[]) => 0)
const deleteMessage = vi.fn(async (..._a: unknown[]) => true)
const editShoppingBoard = vi.fn(async (..._a: unknown[]) => true)
vi.mock('@/lib/telegram/client', () => ({
  sendShoppingBoard: (...a: unknown[]) => sendShoppingBoard(...a),
  deleteMessage: (...a: unknown[]) => deleteMessage(...a),
  editShoppingBoard: (...a: unknown[]) => editShoppingBoard(...a),
}))
const send = vi.fn(async (..._a: unknown[]) => ({ ids: [] as string[] }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }))

const {
  shoppingBoardText,
  boardItem,
  runShoppingRepost,
  requestShoppingRepost,
  requestShoppingRepostForHouse,
  retireShoppingBoard,
  EMPTY_BOARD,
  MOVED_DOWN,
  NO_LONGER_UPDATED,
  SHOPPING_CHANGED,
} = await import('@/lib/lists/board')

const HOUSE = '-100boardHouse'
const THREAD = 55
const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }

describe('shoppingBoardText — the posted message', () => {
  it('is a header with the count, then one bullet per item, in order', () => {
    expect(shoppingBoardText(['milk', 'bin bags', 'oat milk'])).toBe('🛒 Shopping list (3)\n• milk\n• bin bags\n• oat milk')
  })

  it('an empty list is the short line', () => {
    expect(shoppingBoardText([])).toBe('The list is empty.')
    expect(EMPTY_BOARD).toBe('The list is empty.')
    // an item that sanitises to nothing is not an item
    expect(shoppingBoardText(['  ', '\n'])).toBe(EMPTY_BOARD)
  })

  it('an item can never fake a line of its own (newlines collapse to one line)', () => {
    const text = shoppingBoardText(['milk\n• free beer\nThe list is empty.'])
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toBe('🛒 Shopping list (1)\n• milk • free beer The list is empty.')
  })

  it('a mention, hashtag, cashtag or /command in an item is defanged — nothing for Telegram to parse', () => {
    expect(boardItem('ask @chloe')).toBe('ask ＠chloe')
    expect(boardItem('#party snacks')).toBe('＃party snacks')
    expect(boardItem('$BTC')).toBe('＄BTC')
    expect(boardItem('/shoppingoff')).toBe('∕shoppingoff')
    expect(boardItem('milk /pause@baumy_bot')).toBe('milk ∕pause＠baumy_bot')
    const text = shoppingBoardText(['/shoppingoff', 'ask @chloe'])
    expect(text).not.toMatch(/@\w|(?<!\w)\/\w|#\w/)
  })

  it('leaves ordinary item text readable (quantities, fractions, prices)', () => {
    expect(boardItem('1/2 kg flour')).toBe('1/2 kg flour')
    expect(boardItem('wine (5$ max)')).toBe('wine (5$ max)')
    expect(boardItem('  Oat   Milk  ')).toBe('Oat Milk')
  })

  it('strips control and bidi-override characters', () => {
    expect(boardItem(`milk${String.fromCharCode(0x202e)}evil${String.fromCharCode(7)}`)).toBe('milk evil')
  })

  it('strips the invisible ones too: word joiner / invisible operators, the Arabic letter mark, a soft hyphen', () => {
    for (const cp of [0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x061c, 0x00ad]) expect(boardItem(`milk${String.fromCharCode(cp)}x`)).toBe('milk x')
  })

  it('a non-ASCII hashtag is defanged too (Telegram takes any letter or digit)', () => {
    expect(boardItem('#éclairs')).toBe('＃éclairs')
    expect(boardItem('#пиво')).toBe('＃пиво')
    expect(boardItem('#٣')).toBe('＃٣')
    expect(boardItem('# not a tag')).toBe('# not a tag')
  })

  it('truncation boundary: a last item that fits EXACTLY is shown; one more character forces "…and N more."', () => {
    const head = '🛒 Shopping list (2)\n• a\n• '
    const fits = 'b'.repeat(4096 - head.length)
    const exact = shoppingBoardText(['a', fits])
    expect(exact.length).toBe(4096)
    expect(exact.endsWith(fits)).toBe(true)
    const over = shoppingBoardText(['a', fits + 'b'])
    expect(over).toBe('🛒 Shopping list (2)\n• a\n…and 1 more.')
  })

  it('a list too long for one Telegram message is cut, with the rest counted', () => {
    const items = Array.from({ length: 80 }, (_, i) => `item ${i} ${'x'.repeat(70)}`)
    const text = shoppingBoardText(items)
    expect(text.length).toBeLessThanOrEqual(4096)
    const shown = text.split('\n').filter((l) => l.startsWith('• ')).length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(80)
    expect(text.endsWith(`…and ${80 - shown} more.`)).toBe(true)
    expect(text.startsWith('🛒 Shopping list (80)')).toBe(true)
  })
})

describe('requestShoppingRepost — the debounce trigger', () => {
  beforeEach(() => {
    send.mockReset()
  })

  it('sends lists/shopping.changed for the house, with NO event id (an id would dedupe later changes away)', async () => {
    send.mockResolvedValue({ ids: [] })
    await requestShoppingRepost(HOUSE)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toEqual({ name: SHOPPING_CHANGED, data: { groupId: HOUSE } })
    expect(send.mock.calls[0][0]).not.toHaveProperty('id')
  })

  it('is best-effort: a failed hand-off is logged, never thrown into the list write', async () => {
    send.mockImplementation(async () => {
      throw new Error('401 Event key not found')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(requestShoppingRepost(HOUSE)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('after /resume: asks for a repost of the HOUSE scope', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
    send.mockResolvedValue({ ids: [] })
    await requestShoppingRepostForHouse(db)
    expect(send).toHaveBeenCalledWith({ name: SHOPPING_CHANGED, data: { groupId: HOUSE } })
    vi.unstubAllEnvs()
  })

  it('no scope → nothing sent', async () => {
    await requestShoppingRepost('')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runShoppingRepost — post the list in the topic, retire the old post', () => {
  let db: Database
  const run = () => runShoppingRepost(step, () => db, HOUSE)
  const stored = async () => (await db.select({ chatId: houseConfig.shoppingMessageChatId, id: houseConfig.shoppingMessageId }).from(houseConfig))[0]

  beforeEach(async () => {
    db = await makeTestDb()
    await ensureRegistered(db, HOUSE, null)
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: HOUSE })
    vi.stubEnv('BAUMY_HOUSE_CHAT_ID', '')
    sendShoppingBoard.mockReset()
    deleteMessage.mockReset()
    editShoppingBoard.mockReset()
    let id = 100
    sendShoppingBoard.mockImplementation(async () => ++id)
    deleteMessage.mockResolvedValue(true)
    editShoppingBoard.mockResolvedValue(true)
  })

  it('no shopping topic → does nothing at all', async () => {
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    expect(await run()).toEqual({ status: 'no-topic' })
    expect(sendShoppingBoard).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect((await stored()).id).toBeNull()
  })

  it('posts the whole open list in the topic and stores its id; the first post has nothing to retire', async () => {
    await setShoppingThread(db, THREAD)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    await addListItems(db, { groupId: HOUSE, items: ['eggs'], addedBy: null })
    expect(await run()).toEqual({ status: 'posted', messageId: 101, previous: 'none' })
    expect(sendShoppingBoard).toHaveBeenCalledTimes(1)
    expect(sendShoppingBoard.mock.calls[0]).toEqual([HOUSE, '🛒 Shopping list (2)\n• milk\n• eggs', THREAD])
    expect(await stored()).toEqual({ chatId: HOUSE, id: 101 })
    expect(deleteMessage).not.toHaveBeenCalled()
  })

  it('the next repost deletes the previous post (after posting the new one)', async () => {
    await setShoppingThread(db, THREAD)
    await addListItems(db, { groupId: HOUSE, items: ['milk'], addedBy: null })
    await run()
    await addListItems(db, { groupId: HOUSE, items: ['eggs'], addedBy: null })
    expect(await run()).toEqual({ status: 'posted', messageId: 102, previous: 'deleted' })
    expect(deleteMessage).toHaveBeenCalledTimes(1)
    expect(deleteMessage.mock.calls[0]).toEqual([HOUSE, 101])
    expect(sendShoppingBoard.mock.invocationCallOrder[1]).toBeLessThan(deleteMessage.mock.invocationCallOrder[0])
    expect(editShoppingBoard).not.toHaveBeenCalled()
    expect(await stored()).toEqual({ chatId: HOUSE, id: 102 })
  })

  it('a refused delete edits the old post to say the list moved down — never two current-looking lists', async () => {
    await setShoppingThread(db, THREAD)
    await run()
    deleteMessage.mockResolvedValue(false)
    expect(await run()).toEqual({ status: 'posted', messageId: 102, previous: 'edited' })
    expect(editShoppingBoard).toHaveBeenCalledTimes(1)
    expect(editShoppingBoard.mock.calls[0]).toEqual([HOUSE, 101, MOVED_DOWN])
    expect(MOVED_DOWN).toBe('⬇️ The list moved down.')
  })

  it('a refused edit too is reported, and the new post still stands', async () => {
    await setShoppingThread(db, THREAD)
    await run()
    deleteMessage.mockResolvedValue(false)
    editShoppingBoard.mockResolvedValue(false)
    expect(await run()).toEqual({ status: 'posted', messageId: 102, previous: 'failed' })
    expect(await stored()).toEqual({ chatId: HOUSE, id: 102 })
  })

  it('an empty list posts the short line', async () => {
    await setShoppingThread(db, THREAD)
    await run()
    expect(sendShoppingBoard.mock.calls[0][1]).toBe('The list is empty.')
  })

  it('paused (/pause) → posts nothing', async () => {
    await setShoppingThread(db, THREAD)
    await setGlobalEnabled(db, false)
    expect(await run()).toEqual({ status: 'paused' })
    expect(sendShoppingBoard).not.toHaveBeenCalled()
  })

  it('an event naming another scope never posts this house\'s list', async () => {
    await setShoppingThread(db, THREAD)
    expect(await runShoppingRepost(step, () => db, '-100elsewhere')).toEqual({ status: 'other-house' })
    expect(sendShoppingBoard).not.toHaveBeenCalled()
  })

  it('posts to the LIVE send id after a supergroup migration, and retires the old post where it was', async () => {
    await setShoppingThread(db, THREAD)
    await run() // posted to HOUSE as 101
    await db.update(houseConfig).set({ liveChatId: '-100live' }).where(eq(houseConfig.id, true))
    await run()
    expect(sendShoppingBoard.mock.calls[1][0]).toBe('-100live')
    expect(deleteMessage.mock.calls[0]).toEqual([HOUSE, 101])
    expect(await stored()).toEqual({ chatId: '-100live', id: 102 })
  })

  it('two OVERLAPPING reposts retire different old posts — never both the same one, never orphaning one', async () => {
    await setShoppingThread(db, THREAD)
    await run() // the existing post: 101
    // A and B both load before either posts; A saves only after B has posted (Inngest limits concurrent
    // STEPS, not whole runs, so this interleaving is possible).
    let aPosted!: () => void
    let bPosted!: () => void
    let aSaved!: () => void
    const aPostedP = new Promise<void>((r) => (aPosted = r))
    const bPostedP = new Promise<void>((r) => (bPosted = r))
    const aSavedP = new Promise<void>((r) => (aSaved = r))
    const stepA = {
      run: async <T>(id: string, fn: () => Promise<T>) => {
        if (id === 'shopping-save') await bPostedP
        const out = await fn()
        if (id === 'shopping-post') aPosted()
        if (id === 'shopping-save') aSaved()
        return out
      },
    }
    const stepB = {
      run: async <T>(id: string, fn: () => Promise<T>) => {
        if (id === 'shopping-post') await aPostedP
        if (id === 'shopping-save') await aSavedP
        const out = await fn()
        if (id === 'shopping-post') bPosted()
        return out
      },
    }
    const [a, b] = await Promise.all([runShoppingRepost(stepA, () => db, HOUSE), runShoppingRepost(stepB, () => db, HOUSE)])
    expect(a).toEqual({ status: 'posted', messageId: 102, previous: 'deleted' })
    expect(b).toEqual({ status: 'posted', messageId: 103, previous: 'deleted' })
    // 101 (before both) and 102 (A's) are deleted; B's 103 is the one live list.
    expect(deleteMessage.mock.calls.map((c) => c[1]).sort()).toEqual([101, 102])
    expect(await stored()).toEqual({ chatId: HOUSE, id: 103 })
  })

  it('a deleted / closed topic: no throw (no retries), the topic is cleared and audited, nothing stored', async () => {
    for (const description of ['Bad Request: message thread not found', 'Bad Request: TOPIC_CLOSED', 'Bad Request: TOPIC_DELETED']) {
      await setShoppingThread(db, THREAD)
      sendShoppingBoard.mockRejectedValueOnce(Object.assign(new Error(`Call to 'sendMessage' failed! (400: ${description})`), { description }))
      expect(await run()).toEqual({ status: 'topic-gone' })
      expect((await resolveHouseIds(db)).shoppingThreadId).toBeNull()
    }
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'shopping.topic.cleared'))
    expect(audit).toHaveLength(3)
    expect(audit[0].metadata).toMatchObject({ threadId: THREAD })
    expect((await stored()).id).toBeNull()
    // …and the next change is a quiet no-op instead of three failing tries.
    expect(await run()).toEqual({ status: 'no-topic' })
  })

  it('a topic-gone failure never clears a DIFFERENT topic a housemate set in the meantime', async () => {
    await setShoppingThread(db, THREAD)
    sendShoppingBoard.mockImplementationOnce(async () => {
      await setShoppingThread(db, 77) // /shoppinghere in a new topic while this run was posting
      throw Object.assign(new Error('400'), { description: 'Bad Request: message thread not found' })
    })
    expect(await run()).toEqual({ status: 'topic-gone' })
    expect((await resolveHouseIds(db)).shoppingThreadId).toBe(77)
  })

  it('any OTHER send failure still throws, so Inngest retries it; the topic stays', async () => {
    await setShoppingThread(db, THREAD)
    sendShoppingBoard.mockRejectedValueOnce(Object.assign(new Error('Too Many Requests: retry after 5'), { description: 'Too Many Requests: retry after 5' }))
    await expect(run()).rejects.toThrow(/Too Many Requests/)
    expect((await resolveHouseIds(db)).shoppingThreadId).toBe(THREAD)
  })

  it('/shoppingoff retire: deletes the last post and clears the stored id', async () => {
    await setShoppingThread(db, THREAD)
    await run() // 101
    expect(await retireShoppingBoard(db)).toBe('deleted')
    expect(deleteMessage.mock.calls[0]).toEqual([HOUSE, 101])
    expect(await stored()).toEqual({ chatId: null, id: null })
    expect(await retireShoppingBoard(db)).toBe('none') // nothing left to take down
    expect(deleteMessage).toHaveBeenCalledTimes(1)
  })

  it('/shoppingoff retire: a refused delete marks the post "no longer updated"', async () => {
    await setShoppingThread(db, THREAD)
    await run()
    deleteMessage.mockResolvedValue(false)
    expect(await retireShoppingBoard(db)).toBe('edited')
    expect(editShoppingBoard.mock.calls[0]).toEqual([HOUSE, 101, NO_LONGER_UPDATED])
    expect(NO_LONGER_UPDATED).toBe('This list is no longer updated.')
    expect((await stored()).id).toBeNull()
  })
})
