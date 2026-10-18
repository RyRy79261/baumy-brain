import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { createPendingAction, resolvePendingAction, pendingForSomeoneElse, reopenPendingAction, pendingTapType, TAPPABLE_ACTIONS, REQUESTER_ONLY_ACTIONS, type TapPayloads } from '@/lib/confirm/store'
import { TAP_HANDLERS } from '@/lib/confirm/handlers'

// Typed payload fixtures (the store types each action's payload on both sides).
const FORGET: TapPayloads['memory.forget'] = { mode: 'soft', factIds: [], scrubValues: ['take the bins out'], noteIds: [], aliasHits: [], summary: 'take the bins out' }
const CANCEL: TapPayloads['reminder.cancel'] = { reminderIds: [], labels: [], target: '' }
const OLYMPICS: TapPayloads['olympics.action'] = { op: 'calendar_add', name: 'create_event', input: {}, idempotencyKey: 'k1', summary: 'add an event' }

describe('pending actions (human-confirm wall)', () => {
  it('confirms exactly once — the atomic single-use resolve', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'memory.forget',
      payload: FORGET,
      requestedBy: '100',
    })
    const first = await resolvePendingAction(db, id, 'confirmed')
    expect(first?.actionType).toBe('memory.forget')
    expect(first?.actionType === 'memory.forget' && first.payload.summary).toBe('take the bins out')
    expect(first?.groupId).toBe('-100') // the stored scope the confirmed action executes in (A1)
    // a second confirm (double-tap / retry) is a no-op
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })

  it('an expired action cannot be confirmed', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'memory.forget',
      payload: FORGET,
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
      payload: FORGET,
      requestedBy: '100',
    })
    expect(await resolvePendingAction(db, id, 'cancelled')).not.toBeNull()
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })
})

describe('requester-only actions (a Baumy Olympics write runs AS its asker)', () => {
  const olympics = (db: Awaited<ReturnType<typeof makeTestDb>>, ttlSec?: number) =>
    createPendingAction(db, { groupId: '-100', actionType: 'olympics.action', payload: OLYMPICS, requestedBy: '703', ttlSec })

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
    const id = await createPendingAction(db, { groupId: '-100', actionType: 'reminder.cancel', payload: CANCEL, requestedBy: '703' })
    expect((await resolvePendingAction(db, id, 'confirmed', '702'))?.actionType).toBe('reminder.cancel')
  })

  it('reopen puts a confirmed card back (Olympics did not answer) — once, and never an expired one', async () => {
    const db = await makeTestDb()
    const id = await olympics(db)
    expect(await reopenPendingAction(db, id)).toBe(false) // still pending: nothing to reopen
    await resolvePendingAction(db, id, 'confirmed', '703')
    expect(await reopenPendingAction(db, id)).toBe(true)
    expect(await reopenPendingAction(db, id)).toBe(false)
    expect((await resolvePendingAction(db, id, 'confirmed', '703'))?.payload).toEqual(OLYMPICS)
    const old = await olympics(db, -1)
    expect(await reopenPendingAction(db, old)).toBe(false)
  })

  it('reopen never touches a card that acts on the house', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, { groupId: '-100', actionType: 'memory.forget', payload: FORGET, requestedBy: '703' })
    await resolvePendingAction(db, id, 'confirmed', '703')
    expect(await reopenPendingAction(db, id)).toBe(false)
  })
})

describe('the tap registry', () => {
  it('every tappable type has a handler, and every handler is a tappable type', () => {
    expect(Object.keys(TAP_HANDLERS).sort()).toEqual([...TAPPABLE_ACTIONS].sort())
  })
  it('the requester-only types are the ones that act AS someone (Olympics)', () => {
    expect([...REQUESTER_ONLY_ACTIONS].sort()).toEqual(['olympics.action', 'olympics.login'])
  })
  it('pendingTapType reads a pending card\'s kind without resolving it; never an expired or handled one', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, { groupId: '-100', actionType: 'reminder.cancel', payload: CANCEL, requestedBy: '1' })
    expect(await pendingTapType(db, id)).toBe('reminder.cancel')
    expect(await pendingTapType(db, id)).toBe('reminder.cancel') // still pending: it did not resolve it
    await resolvePendingAction(db, id, 'confirmed', '1')
    expect(await pendingTapType(db, id)).toBeNull()
    const old = await createPendingAction(db, { groupId: '-100', actionType: 'memory.forget', payload: FORGET, requestedBy: '1', ttlSec: -1 })
    expect(await pendingTapType(db, old)).toBeNull()
  })
})
