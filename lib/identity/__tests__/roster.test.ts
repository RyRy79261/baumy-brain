import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { loadRoster, upsertMember, deactivateMember, parseMyChatMember } from '@/lib/identity/roster'

const GROUP = '-100ros'

describe('loadRoster (fail-closed)', () => {
  beforeEach(() => {
    delete process.env.BAUMY_OWNER_ID
  })

  it('reflects DB members + owner role', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '100', 'Owner', 'owner')
    await upsertMember(db, GROUP, '200', 'Mate', 'member')
    const r = await loadRoster(db)
    expect(r.isOwner(100)).toBe(true)
    expect(r.isOwner(200)).toBe(false)
    expect(r.isMember(200)).toBe(true)
    expect(r.isMember(999)).toBe(false)
    expect(r.canAccessDashboard(100)).toBe(false) // owner ≠ dashboard grant by default
  })

  it('always trusts the env owner even if not in the DB', async () => {
    process.env.BAUMY_OWNER_ID = '777'
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const r = await loadRoster(db)
    expect(r.isOwner(777)).toBe(true)
    expect(r.canAccessDashboard(777)).toBe(true)
  })

  it('a deactivated member is no longer a member', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '300', 'Gone', 'member')
    await deactivateMember(db, '300')
    expect((await loadRoster(db)).isMember(300)).toBe(false)
  })
})

describe('parseMyChatMember', () => {
  it('detects the bot being added + the inviter (→ owner)', () => {
    const u = { my_chat_member: { from: { id: 100 }, chat: { id: -100 }, new_chat_member: { status: 'member' } } }
    const r = parseMyChatMember(u)
    expect(r.botAdded).toBe(true)
    expect(r.inviterId).toBe(100)
    expect(r.chatId).toBe('-100')
  })
  it('ignores a removal', () => {
    const u = { my_chat_member: { from: { id: 100 }, chat: { id: -100 }, new_chat_member: { status: 'left' } } }
    expect(parseMyChatMember(u).botAdded).toBe(false)
  })
  it('ignores a non-mcm update', () => {
    expect(parseMyChatMember({ message: {} }).botAdded).toBe(false)
  })
})
