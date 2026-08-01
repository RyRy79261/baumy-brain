import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GrammyError } from 'grammy'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { houseConfig } from '@/db/schema'
import { convergeMigration } from '@/lib/inngest/functions/migration'

// The migration self-heal (docs/spec/telegram.md D9): a proactive house send to a STALE (pre-upgrade)
// group id gets a 400 with parameters.migrate_to_chat_id; we persist the new live id + retry once,
// never touching the memory scope. Plus the inbound convergence (a migrate service message).

const OLD = '-100old'
const NEW = '-1002222222222'

// Fake the client's transport so we can drive the 400 without a real Bot API call.
const sendToHouse = vi.fn(async (..._a: unknown[]) => {})
vi.mock('@/lib/telegram/client', () => ({ sendToHouse: (...a: unknown[]) => sendToHouse(...a) }))
const { sendToHouseResilient } = await import('@/lib/telegram/house-send')

function migrationError(): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: Number(NEW) } },
    'sendMessage',
    {},
  )
}

describe('sendToHouseResilient — supergroup migration self-heal', () => {
  beforeEach(() => {
    delete process.env.BAUMY_HOUSE_CHAT_ID
    sendToHouse.mockReset()
    sendToHouse.mockResolvedValue(undefined)
  })

  it('on a stale-id 400 it persists the new live id and retries once against it', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    sendToHouse.mockRejectedValueOnce(migrationError()).mockResolvedValueOnce(undefined)

    await sendToHouseResilient(db, 'hello')

    expect(sendToHouse).toHaveBeenCalledTimes(2)
    expect(sendToHouse.mock.calls[0][0]).toBe(OLD) // first attempt → the stale (scope) id
    expect(sendToHouse.mock.calls[1][0]).toBe(NEW) // retry → the new supergroup id
    const [cfg] = await db.select({ live: houseConfig.liveChatId, from: houseConfig.migratedFromChatId, scope: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBe(NEW)
    expect(cfg.from).toBe(OLD)
    expect(cfg.scope).toBe(OLD) // scope (memory key) is NEVER rewritten
  })

  it('a non-migration error propagates and changes no id', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    sendToHouse.mockReset()
    sendToHouse.mockRejectedValueOnce(new Error('network blip'))

    await expect(sendToHouseResilient(db, 'x')).rejects.toThrow('network blip')
    expect(sendToHouse).toHaveBeenCalledTimes(1) // no retry on a real error
    const [cfg] = await db.select({ live: houseConfig.liveChatId }).from(houseConfig).limit(1)
    expect(cfg.live).toBeNull()
  })

  it('once healed, later sends go straight to the new id (no repeat 400)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD, liveChatId: NEW })
    await sendToHouseResilient(db, 'y')
    expect(sendToHouse).toHaveBeenCalledTimes(1)
    expect(sendToHouse.mock.calls[0][0]).toBe(NEW)
  })

  it('routes into the configured reminders topic (message_thread_id)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD, reminderThreadId: 42 })
    await sendToHouseResilient(db, 'reminder')
    expect(sendToHouse.mock.calls[0][0]).toBe(OLD)
    expect(sendToHouse.mock.calls[0][2]).toMatchObject({ threadId: 42 })
  })

  it('no topic set → no thread id (General topic)', async () => {
    const db = await makeTestDb()
    await db.insert(houseConfig).values({ id: true, houseGroupChatId: OLD })
    await sendToHouseResilient(db, 'reminder')
    expect(sendToHouse.mock.calls[0][2]).toMatchObject({ threadId: undefined })
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
