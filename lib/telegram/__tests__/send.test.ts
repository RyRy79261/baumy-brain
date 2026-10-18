import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GrammyError } from 'grammy'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig } from '@/db/schema'
import { deactivateMember } from '@/lib/identity/roster'
import { ensureRegistered } from '@/lib/memory/write'
import { convergeMigration } from '@/lib/inngest/functions/migration'

// The migration self-heal (docs/spec/telegram.md D9): a proactive house send to a STALE (pre-upgrade)
// group id gets a 400 with parameters.migrate_to_chat_id; we persist the new live id + retry once,
// never touching the memory scope. Plus the inbound convergence (a migrate service message).

const OLD = '-100old'
const NEW = '-1002222222222'

// Fake the client's transport so we can drive the 400 without a real Bot API call.
const postMessage = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ postMessage: (...a: unknown[]) => postMessage(...a) }))
const { send, DestinationRefused } = await import('@/lib/telegram/send')
const sendHouse = (db: Parameters<typeof send>[3], text: string) => send({ to: 'house' }, text, {}, db)

function migrationError(): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: Number(NEW) } },
    'sendMessage',
    {},
  )
}

describe("send → house — supergroup migration self-heal", () => {
  beforeEach(() => {
    delete process.env.BAUMY_HOUSE_CHAT_ID
    postMessage.mockReset()
    postMessage.mockResolvedValue(undefined)
  })

  it('on a stale-id 400 it persists the new live id and retries once against it', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    postMessage.mockRejectedValueOnce(migrationError()).mockResolvedValueOnce(undefined)

    await sendHouse(db, 'hello')

    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage.mock.calls[0][0]).toBe(OLD) // first attempt → the stale (scope) id
    expect(postMessage.mock.calls[1][0]).toBe(NEW) // retry → the new supergroup id
    const [cfg] = await db.select({ live: houseConfig.liveChatId, from: houseConfig.migratedFromChatId, scope: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBe(NEW)
    expect(cfg.from).toBe(OLD)
    expect(cfg.scope).toBe(OLD) // scope (memory key) is NEVER rewritten
  })

  it('a non-migration error propagates and changes no id', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    postMessage.mockReset()
    postMessage.mockRejectedValueOnce(new Error('network blip'))

    await expect(sendHouse(db, 'x')).rejects.toThrow('network blip')
    expect(postMessage).toHaveBeenCalledTimes(1) // no retry on a real error
    const [cfg] = await db.select({ live: houseConfig.liveChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBeNull()
  })

  it('once healed, later sends go straight to the new id (no repeat 400)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD, liveChatId: NEW })
    await sendHouse(db, 'y')
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0][0]).toBe(NEW)
  })

  it('routes into the configured reminders topic (message_thread_id)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD, reminderThreadId: 42 })
    await sendHouse(db, 'reminder')
    expect(postMessage.mock.calls[0][0]).toBe(OLD)
    expect(postMessage.mock.calls[0][2]).toMatchObject({ threadId: 42 })
  })

  it('no topic set → no thread id (General topic)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    await sendHouse(db, 'reminder')
    expect(postMessage.mock.calls[0][2]).toMatchObject({ threadId: undefined })
  })
})

// The other two destinations (lib/telegram/send.ts): the chat a message came from, and one active
// housemate's own DM — refused, loudly, for anyone else.
describe('send → chat / member', () => {
  beforeEach(() => {
    postMessage.mockReset()
    postMessage.mockResolvedValue(undefined)
  })

  it('a chat reply goes to that chat, in its forum topic, as a Telegram reply', async () => {
    const db = await makeTestDb()
    await send({ to: 'chat', chatId: OLD, threadId: 7 }, 'hi', { replyTo: 99, windowText: '[w]' }, db)
    expect(postMessage).toHaveBeenCalledWith(OLD, 'hi', expect.objectContaining({ threadId: 7, replyToMessageId: 99, windowText: '[w]' }))
  })

  it("a member DM goes to that member's own chat", async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, OLD, 555, 'Chloe')
    await send({ to: 'member', memberId: '555' }, 'your reminder', {}, db)
    expect(postMessage.mock.calls[0][0]).toBe('555')
  })

  it('a DM to someone who is not an active housemate is refused, never sent', async () => {
    const db = await makeTestDb()
    await expect(send({ to: 'member', memberId: '777' }, 'x', {}, db)).rejects.toBeInstanceOf(DestinationRefused)
    await ensureRegistered(db, OLD, 555, 'Chloe')
    await deactivateMember(db, '555')
    await expect(send({ to: 'member', memberId: '555' }, 'x', {}, db)).rejects.toBeInstanceOf(DestinationRefused)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('convergeMigration — inbound service-message convergence', () => {
  beforeEach(() => {
    delete process.env.BAUMY_HOUSE_CHAT_ID
  })

  it('moves the live id when the migrating chat is our current house (scope), scope untouched', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    const res = await convergeMigration(db, OLD, NEW)
    expect(res.migrated).toEqual({ from: OLD, to: NEW })
    const [cfg] = await db.select({ live: houseConfig.liveChatId, scope: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBe(NEW)
    expect(cfg.scope).toBe(OLD)
  })

  it('IGNORES a migration for a chat we do not know as the house (no hijack)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    const res = await convergeMigration(db, '-100stranger', '-100attacker')
    expect(res.ignored).toBe('not-house')
    const [cfg] = await db.select({ live: houseConfig.liveChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBeNull() // destination unchanged
  })

  it('is idempotent — replaying the same migration is a no-op', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD, liveChatId: NEW })
    const res = await convergeMigration(db, OLD, NEW)
    expect(res.alreadyConverged).toBe(NEW)
  })
})
