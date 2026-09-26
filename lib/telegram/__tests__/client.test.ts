import { describe, it, expect, vi, beforeEach } from 'vitest'

// The transport's cosmetic calls must never break the pipeline — but a rejected reaction is LOGGED,
// not silently swallowed (K1: an off-list 🧠 was 400'd on every call and nobody could see it).
const setMessageReaction = vi.fn(async (..._a: unknown[]): Promise<true> => true)
const getMe = vi.fn(async () => ({ id: 4242, username: 'Baumy_Bot', is_bot: true, first_name: 'Baumy' }))
const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: 321 }))
vi.mock('grammy', () => ({
  Api: class {
    setMessageReaction = (...a: unknown[]) => setMessageReaction(...a)
    getMe = () => getMe()
    sendMessage = (...a: unknown[]) => sendMessage(...a)
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
      const { sendToHouse } = await import('@/lib/telegram/client')
      await expect(sendToHouse('-100h', 'hello house')).resolves.toBeUndefined()
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('conversation-window')
    } finally {
      warn.mockRestore()
      __setDbOverride(null)
    }
  })
})
