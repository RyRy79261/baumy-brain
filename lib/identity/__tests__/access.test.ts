import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember, deactivateMember, loadRoster } from '@/lib/identity/roster'
import { applyMemberAccess } from '@/lib/identity/access'

// Clean owner semantics — don't let a stray env owner shadow the DB roles.
delete process.env.BAUMY_OWNER_ID

const GROUP = '-100access'

async function seed() {
  const db = await makeTestDb()
  await ensureRegistered(db, GROUP, 1)
  await upsertMember(db, GROUP, '1', 'Owner', 'owner')
  await upsertMember(db, GROUP, '2', 'Marta', 'member')
  await upsertMember(db, GROUP, '3', 'Marco', 'member')
  return db
}

describe('applyMemberAccess — dashboard grant/revoke authz', () => {
  it('the owner grants + revokes a member; access flips live', async () => {
    const db = await seed()
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(false)
    expect(await applyMemberAccess(db, '1', '2', true)).toBe('granted')
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(true)
    expect(await applyMemberAccess(db, '1', '2', false)).toBe('revoked')
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(false)
  })

  it('a NON-owner can never grant (owner-only, re-checked live)', async () => {
    const db = await seed()
    // member 2 (not owner) tries to grant member 3 — denied, nothing changes.
    expect(await applyMemberAccess(db, '2', '3', true)).toBe('denied')
    expect((await loadRoster(db)).canAccessDashboard(3)).toBe(false)
  })

  it('the owner can never revoke their OWN access (lock-out guard)', async () => {
    const db = await seed()
    expect(await applyMemberAccess(db, '1', '1', false)).toBe('denied')
  })

  it('rejects a non-numeric id and an unknown member', async () => {
    const db = await seed()
    expect(await applyMemberAccess(db, '1', 'not-a-number', true)).toBe('invalid')
    expect(await applyMemberAccess(db, '1', '999', true)).toBe('no-such-member')
  })

  it('leaving durably revokes access — rejoining does NOT silently restore the grant', async () => {
    const db = await seed()
    expect(await applyMemberAccess(db, '1', '2', true)).toBe('granted')
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(true)
    // 2 leaves / is kicked — access must be cleared durably, not just masked.
    await deactivateMember(db, '2')
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(false)
    // 2 is re-added (any member can do this) → auto-discovered active again, but the
    // grant must stay OFF until the owner explicitly re-grants.
    await upsertMember(db, GROUP, '2', 'Marta', 'member')
    expect((await loadRoster(db)).canAccessDashboard(2)).toBe(false)
    // and a grant aimed at a member who left (still deactivated) does not take hold.
    await deactivateMember(db, '3')
    expect(await applyMemberAccess(db, '1', '3', true)).toBe('no-such-member')
  })
})
