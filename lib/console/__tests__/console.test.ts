import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { facts } from '@/db/schema'
import { makeTestDb } from '@/lib/memory/__tests__/pglite'
import { ensureRegistered, captureMemory } from '@/lib/memory/write'
import { reconcileFact } from '@/lib/memory/facts'
import { createReminder } from '@/lib/reminders/store'
import { createPendingAction } from '@/lib/confirm/store'
import { embedSync } from '@/lib/ai/embed'
import { pendingWork } from '@/lib/console/pending'
import { houseTimeline, factChain } from '@/lib/console/timeline'

const GROUP = '-100console'
process.env.BAUMY_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64')

// The deterministic stand-in embedder the offline suite uses everywhere — no network, repeatable.
const embed = async (t: string) => embedSync(t)

const hoursAgo = (h: number, from: Date) => new Date(from.getTime() - h * 3_600_000)
const hoursAhead = (h: number, from: Date) => new Date(from.getTime() + h * 3_600_000)

describe('pending view — what Baumy is about to do, at a given now', () => {
  it('sorts scheduled reminders into due / upcoming / stale against the 24h grace window', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-30T09:00:00Z')
    const mk = (content: string, fireAt: Date) => createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content, fireAt, createdBy: null })
    await mk('due — 30 min ago', hoursAgo(0.5, now))
    await mk('upcoming — in 3h', hoursAhead(3, now))
    await mk('stale — 6 weeks ago', hoursAgo(24 * 42, now))

    const p = await pendingWork(db, GROUP, now)
    expect(p.due.map((r) => r.content)).toEqual(['due — 30 min ago'])
    expect(p.upcoming.map((r) => r.content)).toEqual(['upcoming — in 3h'])
    // The months-old backlog is visible as STALE, separated from what will actually be delivered —
    // the whole point of the view: you see the flood before the house does.
    expect(p.stale.map((r) => r.content)).toEqual(['stale — 6 weeks ago'])
  })

  it('re-classifies purely by moving `now` — no wall-clock reads anywhere in the view', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const fireAt = new Date('2026-07-30T12:00:00Z')
    await createReminder(db, { groupId: GROUP, deliverChatId: GROUP, content: 'the one reminder', fireAt, createdBy: null })

    const before = await pendingWork(db, GROUP, new Date('2026-07-30T09:00:00Z'))
    expect(before.upcoming).toHaveLength(1)
    expect(before.due).toHaveLength(0)

    const after = await pendingWork(db, GROUP, new Date('2026-07-30T13:00:00Z'))
    expect(after.due).toHaveLength(1)
    expect(after.upcoming).toHaveLength(0)

    // …and far enough forward it is backlog, not news. This is Phase 2's whole trick, working
    // already: the view is a pure function of (data, now).
    const later = await pendingWork(db, GROUP, new Date('2026-09-30T13:00:00Z'))
    expect(later.stale).toHaveLength(1)
    expect(later.due).toHaveLength(0)
  })

  it('surfaces pending confirm cards WITHOUT their payload, and flags expiry against `now`', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const now = new Date('2026-07-30T09:00:00Z')
    await createPendingAction(db, {
      groupId: GROUP,
      actionType: 'memory.forget',
      payload: { mode: 'purge', scrubValues: ['the door code is 4471'] },
      requestedBy: '900',
    })

    const p = await pendingWork(db, GROUP, now)
    expect(p.confirms).toHaveLength(1)
    expect(p.confirms[0].actionType).toBe('memory.forget')
    // The payload of a forget card names the values being scrubbed. It is provenance — the exact
    // proposal a human reviews — and it is never selected into the console.
    expect(JSON.stringify(p.confirms[0])).not.toContain('4471')
    expect('payload' in p.confirms[0]).toBe(false)

    // Expiry is judged against the passed now, so it stays honest under a simulated clock.
    const wayLater = await pendingWork(db, GROUP, new Date('2026-08-30T09:00:00Z'))
    expect(wayLater.confirms[0].expired).toBe(true)
  })

  it('is group-scoped — another house\'s pending work is invisible', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    await ensureRegistered(db, '-100other', null)
    const now = new Date('2026-07-30T09:00:00Z')
    await createReminder(db, { groupId: '-100other', deliverChatId: '-100other', content: 'not ours', fireAt: hoursAhead(2, now), createdBy: null })
    const p = await pendingWork(db, GROUP, now)
    expect([...p.due, ...p.upcoming, ...p.stale]).toHaveLength(0)
  })
})

describe('timeline — the message is the primary object', () => {
  it('hangs the facts a message produced, and the heads-ups those facts scheduled, off the message', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const memoryItemId = await captureMemory(
      { groupId: GROUP, content: 'zuzana lands on the 8th and needs the cave', memoryType: 'fact', authoredBy: null, trustLevel: 'untrusted', salience: 0.85 },
      { db, embed },
    )
    const eventAt = new Date('2026-07-08T12:00:00Z')
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'zuzana', subjectKind: 'person', predicate: 'arrives_on', object: 'the 8th' },
      authoredBy: null,
      trustLevel: 'untrusted',
      memoryItemId,
      eventAt,
    })
    const [{ id: factId }] = await db.select({ id: facts.id }).from(facts).where(eq(facts.groupId, GROUP)).limit(1)
    await createReminder(db, {
      groupId: GROUP,
      deliverChatId: GROUP,
      content: 'Zuzana lands tomorrow and is taking the cave',
      fireAt: new Date('2026-07-07T08:00:00Z'),
      anchorKind: 'event_offset',
      eventFactId: factId,
      createdBy: null,
    })

    const timeline = await houseTimeline(db, GROUP)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].content).toContain('zuzana lands')
    // the fan-out: message → fact → scheduled heads-up, correlated without reading timestamps
    expect(timeline[0].facts).toHaveLength(1)
    expect(timeline[0].facts[0].predicate).toBe('arrives_on')
    expect(timeline[0].facts[0].reminders.map((r) => r.content)).toEqual(['Zuzana lands tomorrow and is taking the cave'])
  })

  it('shows a superseded fact as a chain, oldest → newest, from any link in it', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const f = (object: string) =>
      reconcileFact(db, {
        groupId: GROUP,
        fact: { subject: 'nadia', subjectKind: 'person', predicate: 'arrives_on', object },
        authoredBy: null,
        trustLevel: 'untrusted',
      })
    await f('friday')
    await f('saturday')
    await f('cancelled')

    const all = await db.select({ id: facts.id, isCurrent: facts.isCurrent }).from(facts).where(eq(facts.groupId, GROUP))
    expect(all).toHaveLength(3)

    // Walking from the CURRENT link still returns the whole history in order…
    const current = all.find((r) => r.isCurrent)!
    const chain = await factChain(db, GROUP, current.id)
    expect(chain.map((c) => c.objectValue)).toEqual(['friday', 'saturday', 'cancelled'])
    expect(chain.filter((c) => c.isCurrent)).toHaveLength(1)

    // …and so does walking from an OLD one: back through derived_from, forward through superseded_by.
    const oldest = chain[0]
    expect((await factChain(db, GROUP, oldest.id)).map((c) => c.objectValue)).toEqual(['friday', 'saturday', 'cancelled'])
  })

  it('never selects an encrypted value into the timeline', async () => {
    const db = await makeTestDb()
    await ensureRegistered(db, GROUP, null)
    const memoryItemId = await captureMemory(
      { groupId: GROUP, content: 'the wifi password is hunter2butlonger', memoryType: 'fact', authoredBy: null, trustLevel: 'trusted', salience: 0.9 },
      { db, embed },
    )
    await reconcileFact(db, {
      groupId: GROUP,
      fact: { subject: 'the wifi', predicate: 'password', object: 'hunter2butlonger' },
      authoredBy: null,
      trustLevel: 'trusted',
      memoryItemId,
    })
    const timeline = await houseTimeline(db, GROUP)
    const secure = timeline.flatMap((t) => t.facts).filter((f) => f.isSecure)
    expect(secure.length).toBeGreaterThan(0)
    // object_value is NULL for a secure fact and the ciphertext column is never selected, so the
    // secret cannot appear in the rendered payload at all.
    for (const f of secure) expect(f.objectValue).toBeNull()
    expect(JSON.stringify(timeline)).not.toContain('hunter2butlonger')
  })
})
