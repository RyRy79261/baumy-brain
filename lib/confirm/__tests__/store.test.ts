import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { createPendingAction, resolvePendingAction, pendingForSomeoneElse, reopenPendingAction } from '@/lib/confirm/store'

describe('pending actions (human-confirm wall)', () => {
  it('confirms exactly once — the atomic single-use resolve', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'memory.forget',
      payload: { content: 'take the bins out' },
      requestedBy: '100',
    })
    const first = await resolvePendingAction(db, id, 'confirmed')
    expect(first?.actionType).toBe('memory.forget')
    expect((first?.payload as { content: string }).content).toBe('take the bins out')
    expect(first?.groupId).toBe('-100') // the stored scope the confirmed action executes in (A1)
    // a second confirm (double-tap / retry) is a no-op
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })

  it('an expired action cannot be confirmed', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'memory.forget',
      payload: {},
      requestedBy: '100',
      ttlSec: -1, // already expired
    })
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })

  it('a cancelled action can never later be confirmed', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'memory.forget',
      payload: {},
      requestedBy: '100',
    })
    expect(await resolvePendingAction(db, id, 'cancelled')).not.toBeNull()
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })
})

describe('requester-only actions (a Baumy Olympics write runs AS its asker)', () => {
  const olympics = (db: Awaited<ReturnType<typeof makeTestDb>>, ttlSec?: number) =>
    createPendingAction(db, { groupId: '-100', actionType: 'olympics.action', payload: { name: 'create_event' }, requestedBy: '703', ttlSec })

  it("only the asker's tap resolves it — another member's confirm or cancel does nothing", async () => {
    const db = await makeTestDb()
    const id = await olympics(db)
    expect(await resolvePendingAction(db, id, 'confirmed', '702')).toBeNull()
    expect(await resolvePendingAction(db, id, 'cancelled', '702')).toBeNull()
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull() // no tapper → never
    expect(await pendingForSomeoneElse(db, id, '702')).toEqual({ actionType: 'olympics.action' })
    expect(await pendingForSomeoneElse(db, id, '703')).toBeNull()
    expect((await resolvePendingAction(db, id, 'confirmed', '703'))?.actionType).toBe('olympics.action')
    expect(await pendingForSomeoneElse(db, id, '702')).toBeNull() // handled now: the ordinary answer
  })

  it('other actions stay tappable by any member', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, { groupId: '-100', actionType: 'reminder.cancel', payload: {}, requestedBy: '703' })
    expect((await resolvePendingAction(db, id, 'confirmed', '702'))?.actionType).toBe('reminder.cancel')
  })

  it('reopen puts a confirmed card back (Olympics did not answer) — once, and never an expired one', async () => {
    const db = await makeTestDb()
    const id = await olympics(db)
    expect(await reopenPendingAction(db, id)).toBe(false) // still pending: nothing to reopen
    await resolvePendingAction(db, id, 'confirmed', '703')
    expect(await reopenPendingAction(db, id)).toBe(true)
    expect(await reopenPendingAction(db, id)).toBe(false)
    expect((await resolvePendingAction(db, id, 'confirmed', '703'))?.payload).toEqual({ name: 'create_event' })
    const old = await olympics(db, -1)
    expect(await reopenPendingAction(db, old)).toBe(false)
  })

  it('reopen never touches a card that acts on the house', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, { groupId: '-100', actionType: 'memory.forget', payload: {}, requestedBy: '703' })
    await resolvePendingAction(db, id, 'confirmed', '703')
    expect(await reopenPendingAction(db, id)).toBe(false)
  })
})
