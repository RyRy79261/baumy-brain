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
    // A3: the reply model is never told what the reminder step did, so it can't confirm the actual
    // time (or honestly say it failed). Spec §4 THIS TURN + MODE: confirm.
    knownGap: { refs: 'A3', phase: 1, note: 'THIS TURN outcome + confirm mode' },
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
    // A2/A3: the failed parse is silent — the reply model answers the raw text as a QUESTION with no
    // idea nothing was scheduled. Spec: reminder needs_time → MODE: clarify.
    knownGap: { refs: 'A2 A3', phase: 1, note: 'reminder outcome needs_time → clarify' },
    fixtures,
    steps: [
      say('Ryan', VAGUE, { mention: true }),
      expectPrompt('reply', /^MODE: clarify$/m, 'the model was told to ask for the missing time'),
      expectPrompt('reply', (c) => !/reminder set/i.test(c.prompt), 'the model was never told a reminder was set'),
    ],
  })

  scenario('an undirected "remind us" in the group creates no reminder', {
    people: HOUSE,
    startAt: start,
    // A9: un-directed group text still creates reminders; spec §3 requires a directed ask.
    knownGap: { refs: 'A9', phase: 1, note: 'undirected reminders are not created' },
    fixtures,
    steps: [say('Ryan', BINS), expectReminder({ count: 0 })],
  })

  scenario('editing a reminder request replaces the reminder and never re-replies', {
    people: HOUSE,
    startAt: start,
    // I1: an edit arrives as a new update with the same message_id and re-runs everything —
    // duplicate reminder, second reply. Spec §8: the edit supersedes, never re-replies.
    knownGap: { refs: 'I1', phase: 5, note: 'baumy_messages edit mapping' },
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
