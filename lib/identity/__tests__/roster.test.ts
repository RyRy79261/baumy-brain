import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { members } from '@/db/schema'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import {
  loadRoster,
  upsertMember,
  deactivateMember,
  parseMyChatMember,
  parseChatMember,
  setDashboardAccess,
  listActiveMembers,
} from '@/lib/identity/roster'

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

  // The dashboard grant must be LIVE (spec D2/D8): both the magic-link redeem and
  // requireAdmin() recompute canAccessDashboard from the DB on every request, so a
  // revoked grant or a deactivated member is denied immediately — never cached.
  it('the dashboard grant is live: revoke or deactivate flips canAccessDashboard at once', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '400', 'Admin', 'member')

    await db.update(members).set({ canAccessDashboard: true }).where(eq(members.telegramUserId, '400'))
    expect((await loadRoster(db)).canAccessDashboard(400)).toBe(true)

    // revoke → immediately denied (no admit cached in a session)
    await db.update(members).set({ canAccessDashboard: false }).where(eq(members.telegramUserId, '400'))
    expect((await loadRoster(db)).canAccessDashboard(400)).toBe(false)

    // re-grant then deactivate → is_active gates it shut regardless of the grant
    await db.update(members).set({ canAccessDashboard: true }).where(eq(members.telegramUserId, '400'))
    await deactivateMember(db, '400')
    expect((await loadRoster(db)).canAccessDashboard(400)).toBe(false)
  })
})

describe('owner administration', () => {
  it('grant/revoke flips can_access_dashboard; unknown id is a no-op', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '500', 'Tom', 'member')

    expect(await setDashboardAccess(db, '500', true)).toBe(true)
    expect((await loadRoster(db)).canAccessDashboard(500)).toBe(true)
    expect(await setDashboardAccess(db, '500', false)).toBe(true)
    expect((await loadRoster(db)).canAccessDashboard(500)).toBe(false)
    expect(await setDashboardAccess(db, '999', true)).toBe(false) // no such member
  })

  it('listActiveMembers returns only active rows with role + dashboard flag', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await upsertMember(db, GROUP, '100', 'Owner', 'owner')
    await upsertMember(db, GROUP, '200', 'Gone', 'member')
    await deactivateMember(db, '200')
    const mates = await listActiveMembers(db)
    expect(mates.map((m) => m.id)).toEqual(['100'])
    expect(mates[0].role).toBe('owner')
  })
})

describe('parseChatMember (housemate join/leave)', () => {
  it('reads a leave (→ deactivate) and a join (→ register)', () => {
    const left = parseChatMember({ chat_member: { chat: { id: -100 }, new_chat_member: { user: { id: 42, first_name: 'Ann' }, status: 'left' } } })
    expect(left).toEqual({ userId: '42', status: 'left', name: 'Ann', chatId: '-100' }) // chat id threaded for the house-lane guard
    const joined = parseChatMember({ chat_member: { new_chat_member: { user: { id: 7 }, status: 'member' } } })
    expect(joined.status).toBe('member')
    expect(joined.chatId).toBeNull() // no chat.id in the payload
    expect(parseChatMember({ message: {} }).userId).toBeNull()
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
