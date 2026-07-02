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
