import { describe, it, expect, vi, beforeEach } from 'vitest'

// The transport's cosmetic calls must never break the pipeline — but a rejected reaction is LOGGED,
// not silently swallowed (K1: an off-list 🧠 was 400'd on every call and nobody could see it).
const setMessageReaction = vi.fn(async (..._a: unknown[]): Promise<true> => true)
const getMe = vi.fn(async () => ({ id: 4242, username: 'Baumy_Bot', is_bot: true, first_name: 'Baumy' }))
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: 321 }))
const deleteMessageApi = vi.fn(async (..._a: unknown[]): Promise<true> => true)
const editMessageTextApi = vi.fn(async (..._a: unknown[]): Promise<unknown> => true)
const pinChatMessage = vi.fn(async (..._a: unknown[]): Promise<true> => true)
const unpinChatMessage = vi.fn(async (..._a: unknown[]): Promise<true> => true)
vi.mock('grammy', () => ({
  Api: class {
    setMessageReaction = (...a: unknown[]) => setMessageReaction(...a)
    getMe = () => getMe()
    sendMessage = (...a: unknown[]) => sendMessage(...a)
    deleteMessage = (...a: unknown[]) => deleteMessageApi(...a)
    editMessageText = (...a: unknown[]) => editMessageTextApi(...a)
    pinChatMessage = (...a: unknown[]) => pinChatMessage(...a)
    unpinChatMessage = (...a: unknown[]) => unpinChatMessage(...a)
  },
}))

beforeEach(() => {
  vi.resetModules()
  setMessageReaction.mockReset()
  getMe.mockReset()
  process.env.TELEGRAM_BOT_TOKEN = '123456:secret'
})

describe('reactToMessage', () => {
  it('sends the emoji reaction', async () => {
    setMessageReaction.mockResolvedValue(true)
    const { reactToMessage } = await import('@/lib/telegram/client')
    await reactToMessage('-100h', 5, '✍')
    expect(setMessageReaction).toHaveBeenCalledWith('-100h', 5, [{ type: 'emoji', emoji: '✍' }])
  })

  it('a Telegram rejection does not throw, but IS logged (console.warn)', async () => {
    setMessageReaction.mockRejectedValue(new Error('Bad Request: REACTION_INVALID'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { reactToMessage } = await import('@/lib/telegram/client')
    await expect(reactToMessage('-100h', 5, '👀')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('👀')
    expect(String(warn.mock.calls[0][1])).toContain('REACTION_INVALID')
    warn.mockRestore()
  })
})

describe('getBotId (C8 — reply-to-Baumy is decided by id)', () => {
  it('reads getMe, caches it (and the username)', async () => {
    getMe.mockResolvedValue({ id: 4242, username: 'Baumy_Bot', is_bot: true, first_name: 'Baumy' })
    const { getBotId, getBotUsername } = await import('@/lib/telegram/client')
    expect(await getBotId()).toBe(4242)
    expect(await getBotId()).toBe(4242)
    expect(await getBotUsername()).toBe('baumy_bot')
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('falls back to the token prefix (the bot id) when getMe is unreachable — never "undirected by accident"', async () => {
    getMe.mockRejectedValue(new Error('fetch failed'))
    const { getBotId } = await import('@/lib/telegram/client')
    expect(await getBotId()).toBe(123456)
  })
})

describe('the send seam feeds the conversation window (chat-understanding-v2 §5)', () => {
  it('a window failure AFTER a successful send is logged, never thrown (a retry would double-post)', async () => {
    const { __setDbOverride } = await import('@/db/client')
    __setDbOverride({
      select: () => {
        throw new Error('db down')
      },
    } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { postMessage } = await import('@/lib/telegram/client')
      await expect(postMessage('-100h', 'hello house')).resolves.toBeUndefined()
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('conversation-window')
    } finally {
      warn.mockRestore()
      __setDbOverride(null)
    }
  })
})

// Taking an old live shopping list down (docs/spec/shopping-list.md §Live list): delete it, or edit it to
// "no longer updated" with its buttons gone — never thrown.
describe('the old live list\'s delete and edit fallback', () => {
  beforeEach(() => {
    sendMessage.mockClear()
    deleteMessageApi.mockReset()
    editMessageTextApi.mockReset()
  })

  it('a refused delete is false + logged, never thrown (the caller falls back to an edit)', async () => {
    deleteMessageApi.mockRejectedValue(new Error("Bad Request: message can't be deleted"))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deleteMessage } = await import('@/lib/telegram/client')
    expect(await deleteMessage('-100h', 5)).toBe(false)
    expect(String(warn.mock.calls[0][1])).toContain("can't be deleted")
    warn.mockRestore()
    deleteMessageApi.mockResolvedValue(true)
    expect(await deleteMessage('-100h', 5)).toBe(true)
    expect(deleteMessageApi).toHaveBeenLastCalledWith('-100h', 5)
  })

  it('the edit fallback rewrites the old post; a refused edit is false + logged', async () => {
    const { editShoppingBoard } = await import('@/lib/telegram/client')
    editMessageTextApi.mockResolvedValue(true)
    expect(await editShoppingBoard('-100h', 5, 'This list is no longer updated.')).toBe(true)
    expect(editMessageTextApi.mock.calls[0].slice(0, 3)).toEqual(['-100h', 5, 'This list is no longer updated.'])
    expect(editMessageTextApi.mock.calls[0][3]).not.toHaveProperty('reply_markup') // the buttons go
    editMessageTextApi.mockRejectedValue(new Error('Bad Request: message to edit not found'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await editShoppingBoard('-100h', 5, 'This list is no longer updated.')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('the live shopping list transport (issue #25)', () => {
  const keyboard = [[{ text: '☐ milk', callback_data: 'shop:chk:00000000-0000-4000-8000-000000000001' }], [{ text: '🔄 Refresh', callback_data: 'shop:refresh' }]]
  const tg = (description: string, code = 400) => Object.assign(new Error(description), { description, error_code: code })
  beforeEach(() => {
    sendMessage.mockClear()
    editMessageTextApi.mockReset()
    pinChatMessage.mockReset()
    unpinChatMessage.mockReset()
  })

  it('posts plain text with the inline keyboard, in the topic (or General), and returns the id', async () => {
    sendMessage.mockResolvedValueOnce({ message_id: 900 })
    const { sendLiveList } = await import('@/lib/telegram/client')
    expect(await sendLiveList('-100h', '🛒 Shopping list', keyboard, 55)).toBe(900)
    const [, , opts] = sendMessage.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.message_thread_id).toBe(55)
    expect(opts.reply_markup).toEqual({ inline_keyboard: keyboard })
    expect(opts).not.toHaveProperty('parse_mode')
    sendMessage.mockResolvedValueOnce({ message_id: 901 })
    await sendLiveList('-100h', '🛒 Shopping list', keyboard, null)
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty('message_thread_id')
  })

  it('edits text + keyboard in place; "message is not modified" is unchanged (a success); a deleted message is gone; anything else throws', async () => {
    const { editLiveList } = await import('@/lib/telegram/client')
    editMessageTextApi.mockResolvedValueOnce(true)
    expect(await editLiveList('-100h', 5, 'text', keyboard)).toBe('edited')
    expect(editMessageTextApi.mock.calls[0][3]).toMatchObject({ reply_markup: { inline_keyboard: keyboard } })
    editMessageTextApi.mockRejectedValueOnce(tg('Bad Request: message is not modified: specified new message content and reply markup are exactly the same'))
    expect(await editLiveList('-100h', 5, 'text', keyboard)).toBe('unchanged')
    editMessageTextApi.mockRejectedValueOnce(tg('Bad Request: message to edit not found'))
    expect(await editLiveList('-100h', 5, 'text', keyboard)).toBe('gone')
    editMessageTextApi.mockRejectedValueOnce(tg("Bad Request: message can't be edited"))
    expect(await editLiveList('-100h', 5, 'text', keyboard)).toBe('gone')
    editMessageTextApi.mockRejectedValueOnce(tg('Too Many Requests: retry after 7', 429))
    await expect(editLiveList('-100h', 5, 'text', keyboard)).rejects.toThrow(/Too Many Requests/)
  })

  it('pins silently (disable_notification); a refused pin or unpin is false + logged, never thrown', async () => {
    const { pinMessage, unpinMessage } = await import('@/lib/telegram/client')
    pinChatMessage.mockResolvedValueOnce(true)
    expect(await pinMessage('-100h', 5)).toBe(true)
    expect(pinChatMessage).toHaveBeenCalledWith('-100h', 5, { disable_notification: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinChatMessage.mockRejectedValueOnce(tg('Bad Request: not enough rights to manage pinned messages in the chat'))
    expect(await pinMessage('-100h', 5)).toBe(false)
    unpinChatMessage.mockRejectedValueOnce(tg('Bad Request: not enough rights'))
    expect(await unpinMessage('-100h', 5)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
