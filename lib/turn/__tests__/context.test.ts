import { describe, it, expect } from 'vitest'
import { buildTurnContext, describeOutcome, describeWhere, summarizeFact } from '@/lib/turn/context'

// The TurnContext is pure: transport facts in, context out — nothing in it comes from message text.

const input = {
  updateId: 1,
  messageId: 9,
  chatId: '-100h',
  houseScope: '-100h',
  lane: 'house' as const,
  fromId: 701,
  senderName: 'Charli Weber',
  isOwner: true,
  anonymous: false,
  authorId: '701',
  trust: 'untrusted' as const,
  sentAt: new Date('2026-09-26T19:40:00Z'),
  tz: 'Europe/Berlin',
  threadId: null,
  isConsole: false,
  directed: { value: false, why: null },
  replyTo: null,
  text: 'hi',
}

describe('buildTurnContext', () => {
  it('maps transport facts into the turn, with an empty outcome and window', () => {
    const c = buildTurnContext(input)
    expect(c.sender).toEqual({ id: 701, name: 'Charli Weber', firstName: 'Charli', role: 'owner' })
    expect(c).toMatchObject({ chatId: '-100h', houseScope: '-100h', lane: 'house', trust: 'untrusted', outcome: {}, recent: [] })
  })
  it('an anonymous admin is never given a housemate’s name; a nameless sender is "a housemate"', () => {
    expect(buildTurnContext({ ...input, anonymous: true, authorId: null }).sender.name).toBe('an admin (posting anonymously)')
    expect(buildTurnContext({ ...input, senderName: null }).sender.firstName).toBe('a housemate')
    expect(buildTurnContext({ ...input, senderName: '  ' }).sender.name).toBe('a housemate')
  })
})

describe('describeWhere', () => {
  it('names the DM, the ask-Baumy topic, another topic, or the group', () => {
    expect(describeWhere({ lane: 'member_dm', topic: { threadId: null, isConsole: false } })).toMatch(/private DM/)
    expect(describeWhere({ lane: 'house', topic: { threadId: 77, isConsole: true } })).toBe('house group, ask-Baumy topic')
    expect(describeWhere({ lane: 'house', topic: { threadId: 5, isConsole: false } })).toBe('house group, a topic thread')
    expect(describeWhere({ lane: 'house', topic: { threadId: null, isConsole: false } })).toBe('house group')
  })
})

describe('describeOutcome — THIS TURN', () => {
  it('lists what actually happened, one clause per action', () => {
    const s = describeOutcome(
      {
        captured: { memoryItemId: 'n', factIds: ['f'], learned: [summarizeFact({ subject: 'zuzka', predicate: 'stays_in', object: "charli's room" }, 'Sat 3 Oct')], rejected: [] },
        reminder: { status: 'set', fireAt: new Date('2026-10-02T18:00:00Z'), content: 'bins out', deliverTo: 'house' },
        list: { op: 'checkoff', added: [], already: [], checkedOff: ['milk'], notFound: ['eggs'], open: ['bread'] },
      },
      'Europe/Berlin',
    )
    expect(s).toBe(
      "noted — zuzka · stays in · charli's room (Sat 3 Oct); reminder set Fri 2 Oct 20:00 — bins out; ticked off the shopping list: milk; NOT on the shopping list (nothing ticked): eggs; shopping list now: bread",
    )
  })
  it('a reminder cancellation: waiting for a tap (nothing cancelled yet), or NOT cancelled with what IS scheduled', () => {
    const tz = 'Europe/Berlin'
    expect(describeOutcome({ cancelReminder: { proposed: true, pendingId: 'p', card: 'c', items: ['⏰ put the bins out — every Friday 20:00'] } }, tz)).toBe(
      'a reminder cancellation is waiting for a confirm tap (NOTHING cancelled yet): ⏰ put the bins out — every Friday 20:00',
    )
    const nothing = describeOutcome(
      { cancelReminder: { proposed: false, reason: 'nothing', target: 'plumber', candidates: [], scheduled: ['⏰ put the bins out — every Friday 20:00'] } },
      tz,
    )
    expect(nothing).toBe('NO reminder was cancelled — nothing scheduled matches "plumber"; scheduled right now that they can see: ⏰ put the bins out — every Friday 20:00')
    const which = describeOutcome({ cancelReminder: { proposed: false, reason: 'ambiguous', target: 'call', candidates: ['⏰ a', '⏰ b'], scheduled: [] } }, tz)
    expect(which).toContain('ask which one they mean: ⏰ a; ⏰ b')
    expect(describeOutcome({ cancelReminder: { proposed: false, reason: 'not_cancel', target: '', candidates: [], scheduled: [] } }, tz)).toBe(
      'nothing was stored, scheduled or changed',
    )
  })
  it('says so when nothing happened, and when a trust-gated fact was refused', () => {
    expect(describeOutcome({}, 'Europe/Berlin')).toBe('nothing was stored, scheduled or changed')
    const r = describeOutcome({ captured: { memoryItemId: 'n', factIds: [], learned: [], rejected: [summarizeFact({ subject: 'rent', predicate: 'is', object: '650' }, null)] } }, 'Europe/Berlin')
    expect(r).toContain('NOT stored (conflicts with something more trusted) — rent · is · 650')
  })
  it('a conflict names both sides and asks; a removal says what no longer holds (spec §7)', () => {
    const s = describeOutcome(
      {
        captured: {
          memoryItemId: 'n',
          factIds: [],
          learned: [{ ...summarizeFact({ subject: 'house', predicate: 'has_guest', object: 'marta' }, null), removed: true }],
          rejected: [],
          conflicts: [
            {
              fact: summarizeFact({ subject: 'zuzka', predicate: 'stays_in', object: 'the cave' }, null),
              current: { object: "charli's room", by: 'Charli', saidAt: '2026-09-25T10:00:00.000Z' },
            },
          ],
        },
      },
      'Europe/Berlin',
    )
    expect(s).toBe(
      "noted that these NO LONGER hold — house · has guest · marta; CONFLICT, not stored as current — this message says zuzka · stays in · the cave, but Charli said zuzka · stays in · charli's room, said Fri 25 Sep; ask which is right",
    )
    expect(s).not.toContain('filed the message')
  })
  it('a secret in a learned fact is a descriptor, never the value (the ack cannot echo it)', () => {
    const f = summarizeFact({ subject: 'wifi', predicate: 'password', object: 'hunter2' }, null)
    expect(f.secure).toBe(true)
    expect(describeOutcome({ captured: { memoryItemId: 'n', factIds: ['f'], learned: [f], rejected: [] } }, 'Europe/Berlin')).not.toContain('hunter2')
  })
  it('…also when the extractor names the predicate in snake_case (has_password, door_code)', () => {
    for (const [subject, predicate, object] of [['wifi', 'has_password', 'hunter3'], ['front door', 'door_code', '4821']]) {
      const f = summarizeFact({ subject, predicate, object }, null)
      expect(f, predicate).toMatchObject({ secure: true, object: '(secret — stored encrypted)' })
    }
  })
  it('a paused reminder says why nothing was scheduled', () => {
    expect(describeOutcome({ reminder: { status: 'paused' } }, 'Europe/Berlin')).toMatch(/no reminder was created — Baumy is paused/)
  })
})
