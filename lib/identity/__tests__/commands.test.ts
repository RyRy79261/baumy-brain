import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { members } from '@/db/schema'

// Telegram sends are mocked; the DB is a real in-memory PGlite injected into the
// command handler (no live model/API/network).
const sendDm = vi.fn(async () => {})
vi.mock('@/lib/telegram/client', () => ({
  sendDmLoginResponse: (...a: unknown[]) => sendDm(...(a as [])),
  sendConfirmCard: vi.fn(async () => {}),
}))

const { handleCommand } = await import('@/lib/identity/commands')

const GROUP = '-100cmd'
const dmOrigin = (fromId: number, dmChatId: string) =>
  ({ lane: 'member_dm', chatId: dmChatId, fromId }) as unknown as Parameters<typeof handleCommand>[0]

describe('handleCommand — /start (orientation + first-DM capture)', () => {
  it('sends the intro and records the member’s DM chat id', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100) // member 100 exists, dm_chat_id NULL
    await handleCommand(dmOrigin(100, '555'), '/start', db)

    // orientation message went to the member's DM
    expect(sendDm).toHaveBeenCalledTimes(1)
    const [chatId, body] = sendDm.mock.calls[0] as unknown as [string, string]
    expect(chatId).toBe('555')
    expect(body.toLowerCase()).toContain('baumy')
    expect(body).toContain('/dashboard') // the one real pointer
    expect(body).not.toContain('Unknown command') // no longer the dead cold-open

    // dm_chat_id is now captured (was a dead column before)
    const [row] = await db.select({ dm: members.dmChatId }).from(members).where(eq(members.telegramUserId, '100'))
    expect(row.dm).toBe('555')
  })

  it('the retired commands (/housemates, /grant, /revoke) are gone', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 100)
    sendDm.mockClear()
    for (const c of ['/housemates', '/grant 123', '/revoke 123']) {
      await handleCommand(dmOrigin(100, '555'), c, db)
    }
    const replies = sendDm.mock.calls.map((c) => (c as unknown as [string, string])[1])
    expect(replies).toEqual(['Unknown command.', 'Unknown command.', 'Unknown command.'])
  })
})

describe('handleCommand — /link <code> (Baumy Olympics member linking)', async () => {
  const { setOlympicsTransport } = await import('@/lib/olympics/client')
  const { FakeOlympics, FAKE_OLYMPICS_URL, FAKE_OLYMPICS_TOKEN } = await import('@/scenarios/olympics-fake')
  const setup = () => {
    const f = new FakeOlympics({ members: [{ id: 'm-anna', displayName: 'Anna' }, { id: 'm-bo', displayName: 'Bo', telegramUserId: '300' }] })
    f.codes.set('ANNACODE12', 'm-anna')
    f.codes.set('ANNACODE34', 'm-anna')
    process.env.OLYMPICS_BASE_URL = FAKE_OLYMPICS_URL
    process.env.BRAIN_SERVICE_TOKEN = FAKE_OLYMPICS_TOKEN
    setOlympicsTransport(f.transport)
    sendDm.mockClear()
    return f
  }
  const reply = () => (sendDm.mock.calls.at(-1) as unknown as [string, string])[1]
  const teardown = () => {
    setOlympicsTransport(null)
    delete process.env.OLYMPICS_BASE_URL
    delete process.env.BRAIN_SERVICE_TOKEN
  }

  it('links the SENDER (X-Baumy-Actor from the authenticated from.id) and says who they are', async () => {
    const f = setup()
    const db = await makeTestDb()
    await handleCommand(dmOrigin(200, '200'), '/link ANNACODE12', db, { messageId: 41 })
    expect(reply()).toBe("🔗 Linked — you're Anna in Baumy Olympics. You can now ask me to add calendar events and log your chores.")
    expect(f.members.find((m) => m.id === 'm-anna')?.telegramUserId).toBe('200')
    expect(f.calls[0]).toMatchObject({ name: 'link_telegram', actor: '200', idempotencyKey: 'tglink-200-41', confirmed: false, body: { code: 'ANNACODE12' } })
    expect(f.audit).toEqual([{ action: 'link_telegram', memberId: 'm-anna', source: 'brain', entityId: 'm-anna' }])
    teardown()
  })

  it('a retried command (same message) replays the answer instead of burning the code twice', async () => {
    const f = setup()
    const db = await makeTestDb()
    await handleCommand(dmOrigin(200, '200'), '/link ANNACODE12', db, { messageId: 41 })
    await handleCommand(dmOrigin(200, '200'), '/link ANNACODE12', db, { messageId: 41 })
    expect(reply()).toMatch(/Linked — you're Anna/)
    expect(f.calls).toHaveLength(2)
    teardown()
  })

  it('a bad, used or expired code; an account linked to someone else; a malformed or missing code', async () => {
    setup()
    const db = await makeTestDb()
    await handleCommand(dmOrigin(200, '200'), '/link WRONGCODE9', db, { messageId: 1 })
    expect(reply()).toMatch(/That code didn't work/)
    await handleCommand(dmOrigin(300, '300'), '/link ANNACODE34', db, { messageId: 2 })
    expect(reply()).toMatch(/already linked to another Olympics member/)
    await handleCommand(dmOrigin(200, '200'), '/link', db, { messageId: 3 })
    expect(reply()).toMatch(/^Send it like this: \/link/)
    await handleCommand(dmOrigin(200, '200'), '/link no!', db, { messageId: 4 })
    expect(reply()).toMatch(/^Send it like this: \/link/)
    teardown()
  })

  it('/start link_<code> (the Olympics deep link) links the sender exactly like /link <code>', async () => {
    const f = setup()
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, 200)
    await handleCommand(dmOrigin(200, '200'), '/start link_ANNACODE12', db, { messageId: 42 })
    expect(sendDm).toHaveBeenCalledTimes(1) // the confirmation only, not the intro as well
    expect(reply()).toBe("🔗 Linked — you're Anna in Baumy Olympics. You can now ask me to add calendar events and log your chores.")
    expect(f.members.find((m) => m.id === 'm-anna')?.telegramUserId).toBe('200')
    expect(f.calls[0]).toMatchObject({ name: 'link_telegram', actor: '200', idempotencyKey: 'tglink-200-42', confirmed: false, body: { code: 'ANNACODE12' } })
    // Still a /start: the DM chat id is captured for later proactive DMs.
    const [row] = await db.select({ dm: members.dmChatId }).from(members).where(eq(members.telegramUserId, '200'))
    expect(row.dm).toBe('200')
    // A spent code answers like /link does.
    await handleCommand(dmOrigin(200, '200'), '/start@baumy_bot link_ANNACODE12', db, { messageId: 43 })
    expect(reply()).toMatch(/That code didn't work/)
    teardown()
  })

  it('/start with any other payload is the plain intro and never calls Olympics', async () => {
    const f = setup()
    const db = await makeTestDb()
    for (const [i, t] of ['/start', '/start hello', '/start link_', '/start link_BAD!CODE', '/start xlink_ANNACODE12'].entries()) {
      await handleCommand(dmOrigin(200, '200'), t, db, { messageId: 50 + i })
      expect(reply()).toContain('/dashboard')
    }
    expect(f.calls).toHaveLength(0)
    teardown()
  })

  it('Olympics not set up or down → a friendly line, never an error', async () => {
    const f = setup()
    const db = await makeTestDb()
    f.down = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await handleCommand(dmOrigin(200, '200'), '/link ANNACODE12', db, { messageId: 5 })
    expect(reply()).toMatch(/isn't answering right now/)
    warn.mockRestore()
    teardown()
    await handleCommand(dmOrigin(200, '200'), '/link ANNACODE12', db, { messageId: 6 })
    expect(reply()).toMatch(/isn't connected to me yet/)
  })
})
