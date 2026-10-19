import { describe } from 'vitest'
import { scenario, say, tap, advance, expectReminder, expectWords, expectPrompt, check, type Run } from './dsl'
import { request, reminderAsk, reminder, chatter } from './shapes'
import { HOUSE } from './house'
import { FakeOlympics } from './olympics-fake'
import type { ModelCall } from './fake-model'

// A FOLLOW-UP to Baumy (spec §1, `follow_up`), from a real house chat (2026-10-19): Ryan @mentioned
// Baumy to put his India trip on the calendar, then — no second @mention, no Telegram reply — asked to
// "also add" the butcher delivery with reminders the day before and 2 days before. Baumy noted it,
// set nothing, and claimed it could not set reminders. Then "@baumy_bot add it to the calendar then"
// still added nothing: the calendar extractor never saw what "it" was.
//
// The rule: the sender's next message right after Baumy answered THEM (≤10 min, nobody in between) is
// a candidate; it stays directed only when triage says it asks Baumy.

const start = '2026-10-19 15:00' // Monday
const INDIA = "Heads up, I'm gonna be in India from the 4th to the 16th of November @baumy_bot could you add this to the calendar"
const BUTCHER = "Could you also add that we'll have a delivery from the butchers on the 11th or 12th of November, make reminders the day before and 2 days before"
const house = () =>
  new FakeOlympics({
    members: [
      { id: 'm-ryan', displayName: 'Ryan', telegramUserId: '703' },
      { id: 'm-marco', displayName: 'Marco' },
    ],
  })
const fake = (r: Run) => r.olympics!

const BUTCHER_EVENT = { op: 'calendar_add' as const, title: 'Butcher delivery', date: '2026-11-11', endDate: '2026-11-12', startTime: '', endTime: '' }
const fixtures = {
  triage: (t: string) =>
    /india/i.test(t)
      ? request({ asksBaumy: true, olympics: 'calendar_add' })
      : /butcher/i.test(t)
        ? reminderAsk({ asksBaumy: true, worthRemembering: true, olympics: 'calendar_add' })
        : /add it to the calendar/i.test(t)
          ? request({ asksBaumy: true, olympics: 'calendar_add' })
          : /remind me to text you/i.test(t)
            ? reminderAsk({ asksBaumy: false })
            : chatter(),
  olympics: (t: string, call: ModelCall) =>
    /india/i.test(t)
      ? { op: 'calendar_add' as const, title: 'Ryan in India', date: '2026-11-04', endDate: '2026-11-16', startTime: '', endTime: '' }
      : /butcher/i.test(t)
        ? BUTCHER_EVENT
        : // "it" is only knowable from RECENT CHAT.
          /add it to the calendar/i.test(t) && /RECENT CHAT[\s\S]*butchers/.test(call.prompt)
          ? BUTCHER_EVENT
          : null,
  reminder: (t: string) =>
    /butcher/i.test(t)
      ? [
          reminder({ content: 'the butcher delivery is in 2 days', when: '2 days before', fireAt: '2026-11-09T09:00', forWhom: 'house' }),
          reminder({ content: 'the butcher delivery is tomorrow', when: 'the day before', fireAt: '2026-11-10T09:00', forWhom: 'house' }),
        ]
      : /remind me to text you/i.test(t)
        ? reminder({ content: 'text Marco about the van', when: 'tomorrow 10am', fireAt: '2026-10-20T10:00', forWhom: 'speaker' })
        : null,
  reply: () => 'Done 😼',
}

const opening = [say('Ryan', INDIA), tap('Ryan'), check('the India trip is on the calendar', (r, e) => e(fake(r).events).toHaveLength(1))]

describe('scenario: a follow-up ask right after Baumy answered', () => {
  scenario('"could you also add … make reminders the day before and 2 days before" (no @mention) → a calendar card + BOTH reminders', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures,
    steps: [
      ...opening,
      say('Ryan', BUTCHER),
      expectWords({
        contains: ['Add this to the house calendar?', 'Butcher delivery'],
        judge: 'Shows a card to add the butcher delivery to the house calendar AND says the two reminders (Mon 9 Nov and Tue 10 Nov) are set. Must NOT say Baumy cannot set reminders or add calendar events.',
      }),
      expectReminder({ content: /butcher/, status: 'scheduled', count: 2 }),
      expectReminder({ content: /in 2 days/, at: '2026-11-09 09:00', count: 1 }),
      expectReminder({ content: /tomorrow/, at: '2026-11-10 09:00', count: 1 }),
      tap('Ryan'),
      check('the delivery is on the calendar too', (r, e) => e(fake(r).events.map((x) => x.title)).toEqual(['Ryan in India', 'Butcher delivery'])),
    ],
  })

  scenario('"@baumy_bot add it to the calendar then" → the event comes from RECENT CHAT', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures: { ...fixtures, triage: (t: string) => (/butcher/i.test(t) ? chatter() : fixtures.triage(t)) },
    steps: [
      ...opening,
      say('Ryan', BUTCHER), // triage: not for Baumy (here, chatter) — nothing happens
      say('Ryan', '@baumy_bot add it to the calendar then'),
      expectPrompt('olympics', /RECENT CHAT[\s\S]*butchers/, 'the calendar extractor sees what "it" is'),
      expectWords({ contains: ['Add this to the house calendar?', 'Butcher delivery'] }),
      tap('Ryan'),
      check('one more event', (r, e) => e(fake(r).events).toHaveLength(2)),
    ],
  })

  scenario('a calendar add with no event to find → Baumy asks which event, never "I cannot"', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures: { ...fixtures, olympics: () => null },
    steps: [
      say('Ryan', '@baumy_bot add it to the calendar then'),
      expectWords({ contains: 'Which event should I put on the calendar, and on what day?' }),
      expectReminder({ count: 0 }),
    ],
  })

  scenario('someone else spoke in between → not a follow-up: no reminders, no card', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures,
    steps: [
      ...opening,
      say('Marco', 'nice, have fun'),
      say('Ryan', BUTCHER),
      expectReminder({ count: 0 }),
      check('no second card', (r, e) => e(r.turns.at(-1)!.entries.filter((x) => x.kind === 'confirm-card')).toHaveLength(0)),
    ],
  })

  scenario('more than 10 minutes later → not a follow-up', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures,
    steps: [...opening, advance({ minutes: 11 }), say('Ryan', BUTCHER), expectReminder({ count: 0 })],
  })

  scenario('a follow-up that is for a housemate (asksBaumy false) → no reminder (A9 holds)', {
    people: HOUSE,
    startAt: start,
    olympics: house,
    fixtures,
    steps: [...opening, say('Ryan', 'Marco remind me to text you about the van tomorrow'), expectReminder({ count: 0 })],
  })
})
