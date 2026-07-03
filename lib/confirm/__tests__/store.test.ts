import { describe, it, expect } from 'vitest'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { createPendingAction, resolvePendingAction } from '@/lib/confirm/store'

describe('pending actions (human-confirm wall)', () => {
  it('confirms exactly once — the atomic single-use resolve', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'reminder.create',
      payload: { content: 'take the bins out' },
      requestedBy: '100',
    })
    const first = await resolvePendingAction(db, id, 'confirmed')
    expect(first?.actionType).toBe('reminder.create')
    expect((first?.payload as { content: string }).content).toBe('take the bins out')
    // a second confirm (double-tap / retry) is a no-op
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })

  it('an expired action cannot be confirmed', async () => {
    const db = await makeTestDb()
    const id = await createPendingAction(db, {
      groupId: '-100',
      actionType: 'reminder.create',
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
      actionType: 'reminder.create',
      payload: {},
      requestedBy: '100',
    })
    expect(await resolvePendingAction(db, id, 'cancelled')).not.toBeNull()
    expect(await resolvePendingAction(db, id, 'confirmed')).toBeNull()
  })
})
