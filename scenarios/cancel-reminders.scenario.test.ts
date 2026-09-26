import { describe } from 'vitest'
import { scenario, say, tap, advance, expectPrompt, expectNoPrompt, expectWords, expectReminder, check, type Run } from './dsl'
import { reminderAsk, cancelReminderAsk, chatter, reminder } from './shapes'
import { HOUSE } from './house'

// Cancelling a reminder from chat (docs/spec/reminders.md §Cancelling from chat). Creating a reminder
// auto-commits; CANCELLING one removes something the house may rely on, so it rides the confirm-tap wall:
// the request only proposes (a card naming exactly what would go), a member's tap cancels every unsent
// row of the series. A personal DM reminder is visible — and cancellable — only by its creator.

const start = '2026-09-28 10:00' // Monday — "friday" is Fri 2 Oct, "saturday" Sat 3 Oct
const BINS = 'every friday 8pm remind us to put the bins out'
const MUM = 'remind me to call mum saturday 6pm'

const fixtures = {
  triage: (t: string) =>
    /\b(stop|cancel|no need)\b/i.test(t) ? cancelReminderAsk({ asksBaumy: true }) : /remind (us|me)/i.test(t) ? reminderAsk({ asksBaumy: true }) : chatter(),
  reminder: (t: string) =>
    /bins/.test(t)
      ? reminder({ content: 'put the bins out', when: 'every friday 8pm', fireAt: '2026-10-02T20:00', recurrence: 'FREQ=WEEKLY;BYDAY=FR', forWhom: 'house' })
      : /mum/.test(t)
        ? reminder({ content: 'call mum', when: 'saturday 6pm', fireAt: '2026-10-03T18:00', forWhom: 'speaker' })
        : null,
  cancelReminder: (t: string) => (/bins/.test(t) ? { target: 'bins' } : /mum/.test(t) ? { target: 'call mum' } : /plumber/.test(t) ? { target: 'plumber' } : null),
}

/** Everything Baumy posted during `advance` steps (reminder deliveries), in any chat. */
const delivered = (r: Run, re: RegExp) =>
  r.turns.flatMap((t) => (t.kind === 'advance' ? t.entries : [])).filter((x) => (x.kind === 'message' || x.kind === 'dm') && re.test(x.text ?? ''))
const cardsIn = (r: Run) => r.turns.at(-1)!.entries.filter((x) => x.kind === 'confirm-card')
const thisTurn = (prompt: string) => prompt.match(/THIS TURN: (.*)/)?.[1] ?? ''

describe('scenario: cancelling a reminder from chat', () => {
  scenario('"stop the bins reminder" → a card naming the weekly series → a tap → no bins reminder for the next two weeks', {
    people: HOUSE,
    startAt: start,
    fixtures: { ...fixtures, reply: () => 'Done — every Friday at 20:00 ⏰' },
    steps: [
      say('Ryan', BINS, { mention: true }),
      expectReminder({ content: /bins/, at: '2026-10-02 20:00', status: 'scheduled', count: 1 }),
      advance({ days: 4, hours: 11 }), // → Fri 2 Oct 21:00: the first one goes out, the next is scheduled
      check('delivered once that Friday', (r, e) => e(delivered(r, /put the bins out/)).toHaveLength(1)),
      expectReminder({ content: /bins/, at: '2026-10-09 20:00', status: 'scheduled', count: 1 }),
      say('Marco', 'stop the bins reminder', { mention: true }),
      expectWords({ contains: ['Cancel this reminder?', '⏰ put the bins out — every Friday 20:00', 'Tap to confirm'] }),
      expectNoPrompt('reply', 'the card is deterministic — the reply model never words a cancellation'),
      expectReminder({ content: /bins/, at: '2026-10-09 20:00', status: 'scheduled', count: 1 }), // proposed only
      tap('Charli'),
      check('the card is rewritten to say what was cancelled', (r, e) => {
        const edit = r.turns.at(-1)!.entries.find((x) => x.kind === 'edit')
        e(edit?.text).toMatch(/Cancelled:\n⏰ put the bins out — every Friday 20:00/)
      }),
      expectReminder({ content: /bins/, at: '2026-10-09 20:00', status: 'cancelled', count: 1 }),
      expectReminder({ status: 'scheduled', count: 0 }),
      advance({ days: 14 }), // → Fri 16 Oct 21:00, past two more Fridays
      check('no further bins reminder was ever posted', (r, e) => e(delivered(r, /put the bins out/)).toHaveLength(1)),
      expectReminder({ status: 'scheduled', count: 0 }),
      expectReminder({ content: /bins/, status: 'sent', count: 1 }),
    ],
  })

  scenario('a personal DM reminder is cancelled by its creator, in their DM', {
    people: HOUSE,
    startAt: start,
    fixtures: { ...fixtures, reply: () => 'Got it — Sat 3 Oct, 18:00 ⏰' },
    steps: [
      say('Charli', MUM, { dm: true }),
      expectReminder({ content: 'Charli: call mum', at: '2026-10-03 18:00', status: 'scheduled', count: 1 }),
      say('Charli', 'cancel my reminder to call mum', { dm: true }),
      expectWords({ contains: ['⏰ Charli: call mum — Sat 3 Oct 18:00 (just for you)', 'Tap to confirm'] }),
      tap('Charli'),
      expectReminder({ content: /call mum/, status: 'cancelled', count: 1 }),
      advance({ days: 6 }), // → Sun 4 Oct: Saturday 18:00 passed
      check('nothing about mum was ever delivered', (r, e) => e(delivered(r, /call mum/)).toHaveLength(0)),
    ],
  })

  scenario("another member cannot cancel someone's DM-private reminder — it is not even visible to them", {
    people: HOUSE,
    startAt: start,
    fixtures: { ...fixtures, reply: (t: string) => (/mum/.test(t) ? "I don't have a reminder like that for you 🐈" : 'Got it ⏰') },
    steps: [
      say('Charli', MUM, { dm: true }),
      expectReminder({ content: /call mum/, status: 'scheduled', count: 1 }),
      say('Marco', "cancel Charli's reminder to call mum", { dm: true }),
      check('no confirm card — nothing Marco can see matches', (r, e) => e(cardsIn(r)).toHaveLength(0)),
      expectPrompt('reply', (c) => /NO reminder was cancelled — nothing scheduled matches "call mum"/.test(thisTurn(c.prompt)), 'THIS TURN says nothing was cancelled'),
      expectPrompt('reply', (c) => !/Charli: call mum/.test(thisTurn(c.prompt)), "the list of what is scheduled never shows Charli's private reminder"),
      expectWords({ judge: 'Says no such reminder was found / nothing was cancelled. Must NOT claim a reminder was cancelled, and must not reveal any reminder of Charli.' }),
      say('Marco', 'baumy stop the call mum reminder'), // the group lane cannot see it either
      check('no card in the group either', (r, e) => e(cardsIn(r)).toHaveLength(0)),
      expectReminder({ content: /call mum/, status: 'scheduled', count: 1 }),
    ],
  })

  scenario('nothing matched → words listing what IS scheduled, never a claimed cancellation', {
    people: HOUSE,
    startAt: start,
    fixtures: {
      ...fixtures,
      reply: (t: string) =>
        /plumber/.test(t) ? "No plumber reminder on my list — the only one scheduled is ⏰ put the bins out, every Friday 20:00." : 'Done — every Friday at 20:00 ⏰',
    },
    steps: [
      say('Ryan', BINS, { mention: true }),
      say('Ryan', 'no need to remind us about the plumber anymore', { mention: true }),
      check('no confirm card', (r, e) => e(cardsIn(r)).toHaveLength(0)),
      expectPrompt('reply', /^MODE: answer$/m, 'answered in words'),
      expectPrompt(
        'reply',
        (c) => /NO reminder was cancelled — nothing scheduled matches "plumber"; scheduled right now that they can see: ⏰ put the bins out — every Friday 20:00/.test(thisTurn(c.prompt)),
        'THIS TURN: nothing cancelled, and what is scheduled',
      ),
      expectWords({
        contains: 'put the bins out',
        judge: 'Says there is no plumber reminder (nothing was cancelled) and mentions the bins reminder (every Friday 20:00) as what is scheduled. Must NOT claim anything was cancelled.',
      }),
      expectReminder({ content: /bins/, status: 'scheduled', count: 1 }),
    ],
  })
})
