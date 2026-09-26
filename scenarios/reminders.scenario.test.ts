import { describe } from 'vitest'
import { scenario, say, advance, expectPrompt, expectWords, expectNoWords, expectReaction, expectReminder } from './dsl'
import { reminderAsk, chatter, reminder } from './shapes'
import { HOUSE } from './house'

// Reminders (spec §3 reminder rows, §6): a directed ask is confirmed WITH the resolved time so a
// misparse is visible; an unparseable time is a clarifying question, never a false "done".

// Monday — so "friday" is unambiguously Fri 2 Oct.
const start = '2026-09-28 10:00'
const BINS = 'remind us to take the bins out friday 8pm'
const VAGUE = 'remind us to call the landlord at some point'

const fixtures = {
  triage: (t: string) => (/remind us/i.test(t) ? reminderAsk({ asksBaumy: true }) : chatter()),
  reminder: (t: string) =>
    /bins/.test(t)
      ? reminder({ content: 'take the bins out', when: t.match(/(friday|saturday) 8pm/)?.[0] ?? '' })
      : /landlord/.test(t)
        ? reminder({ content: 'call the landlord', when: '' })
        : null,
  reply: (t: string) => (/landlord/.test(t) ? 'When should I remind you?' : 'Done — Fri 2 Oct, 20:00 ⏰'),
}

describe('scenario: reminders', () => {
  scenario('a directed reminder is created at the resolved local time, answered in words, and delivered then', {
    people: HOUSE,
    startAt: start,
    fixtures,
    steps: [
      say('Ryan', BINS, { mention: true }),
      expectReminder({ content: /bins/, at: '2026-10-02 20:00', status: 'scheduled', count: 1 }),
      expectWords({ judge: 'Confirms the reminder and names the time it resolved to: Friday (2 Oct) at 8pm / 20:00.' }),
      expectReaction({ not: '👎' }),
      advance({ days: 4, hours: 11 }), // → Fri 2 Oct 21:00; the 20:00 digest runs on the way
      expectWords({ contains: /take the bins out/ }),
      expectReminder({ content: /bins/, status: 'sent', count: 1 }),
    ],
  })

  scenario('the reply model is told the reminder was set, with the resolved day and time (confirm mode)', {
    people: HOUSE,
    startAt: start,
    // A3: the reply model is told what the reminder step did (spec §4 THIS TURN) and asked to
    // confirm it (MODE: confirm), so a misparsed time is visible in the reply.
    fixtures,
    steps: [
      say('Ryan', BINS, { mention: true }),
      expectPrompt('reply', /^MODE: confirm$/m, 'the model was told to confirm a completed action'),
      expectPrompt('reply', /reminder set.*Fri 2 Oct.*20:00/i, 'THIS TURN carries the reminder with its resolved day and time'),
    ],
  })

  scenario('an unparseable reminder time creates nothing and never claims it did', {
    people: HOUSE,
    startAt: start,
    fixtures,
    steps: [
      say('Ryan', VAGUE, { mention: true }),
      expectReminder({ count: 0 }),
      expectReaction({ not: '👍' }),
      expectWords({ judge: 'Asks when they want to be reminded. Must NOT say or imply that a reminder was set.' }),
    ],
  })

  scenario('an unparseable reminder time is a clarifying question (clarify mode, needs_time)', {
    people: HOUSE,
    startAt: start,
    // A2/A3: a reminder with no time is an explicit needs_time outcome → MODE: clarify, and the
    // model is never told (or allowed to claim) that anything was scheduled.
    fixtures,
    steps: [
      say('Ryan', VAGUE, { mention: true }),
      expectPrompt('reply', /^MODE: clarify$/m, 'the model was told to ask for the missing time'),
      expectPrompt('reply', (c) => !/reminder set/i.test(c.prompt), 'the model was never told a reminder was set'),
    ],
  })

  scenario('answering the clarifying question creates the reminder (A2/A3 follow-through)', {
    people: HOUSE,
    startAt: start,
    // The clarify mode must be answerable: the open request is kept, and "at 8pm" in reply to
    // Baumy's question completes it — the extractor is shown the pending request and the question.
    fixtures: {
      ...fixtures,
      reminder: (t, c) =>
        /PENDING REMINDER.*landlord/.test(c.prompt) && /8pm/.test(t) ? reminder({ content: 'call the landlord', when: 'at 8pm' }) : fixtures.reminder(t),
      reply: (_t, c) => (/^MODE: clarify$/m.test(c.prompt) ? 'When should I remind you?' : 'Done — tonight, 20:00 ⏰'),
    },
    steps: [
      say('Ryan', VAGUE, { mention: true }),
      expectPrompt('reply', /^MODE: clarify$/m, 'Baumy asks for the time'),
      expectReminder({ count: 0 }),
      say('Ryan', 'at 8pm', { replyToBaumy: true }),
      expectPrompt('reminder', /PENDING REMINDER \(still needs a time; data\): "call the landlord"/, 'the extractor was shown the open request'),
      expectPrompt('reminder', /BAUMY ASKED \(data\): "When should I remind you\?"/, '…and the question it answers'),
      expectReminder({ content: /landlord/, at: '2026-09-28 20:00', status: 'scheduled', count: 1 }),
      expectPrompt('reply', /^MODE: confirm$/m, 'the completed reminder is confirmed with its time'),
      expectWords({ judge: 'Confirms a reminder to call the landlord tonight at 8pm / 20:00.' }),
    ],
  })

  scenario('an undirected "remind us" in the group creates no reminder', {
    people: HOUSE,
    startAt: start,
    // A9: a reminder needs a directed ask (spec §3) — group talk between housemates never schedules one.
    fixtures,
    steps: [say('Ryan', BINS), expectReminder({ count: 0 })],
  })

  scenario('editing a reminder request replaces the reminder and never re-replies', {
    people: HOUSE,
    startAt: start,
    // I1: an edit arrives as a new update with the same message_id and re-runs everything —
    // duplicate reminder, second reply. Spec §8: the edit supersedes, never re-replies.
    knownGap: { refs: 'I1', phase: 5, failsAt: 5, note: 'baumy_messages edit mapping' },
    fixtures,
    steps: [
      say('Ryan', BINS, { mention: true }),
      expectWords(),
      say('Ryan', 'remind us to take the bins out saturday 8pm', { mention: true, edit: true }),
      expectReminder({ content: /bins/, status: 'scheduled', count: 1, at: '2026-10-03 20:00' }),
      expectReminder({ at: '2026-10-02 20:00', status: 'scheduled', count: 0 }),
      expectNoWords(), // no second reply for an edit (a reaction change is fine)
    ],
  })
})
