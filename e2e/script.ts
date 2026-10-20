// What the fake Claude answers in the e2e run (e2e/fake-anthropic.ts): the scripted fixtures of
// scenarios/fake-model.ts, keyed on the message. The model's judgement is not under test here — these
// answers are fixed so every check is about what the stack did with them. Dates are relative to the
// run, so nothing goes stale; the tests import the same helpers to know what to expect.

import { DateTime } from 'luxon'
import type { Fixtures, ModelCall } from '@/scenarios/fake-model'
import { request, reminderAsk, reminder, chatter } from '@/scenarios/shapes'

const TZ = 'Europe/Berlin'
const local = (d: DateTime) => d.toFormat("yyyy-MM-dd'T'HH:mm")
/** The house-local date `n` days from now. */
export const dayFromNow = (n: number) => DateTime.now().setZone(TZ).plus({ days: n }).toISODate()!

// The house chat of 2026-10-19 (scenarios/followup.scenario.test.ts is the offline version).
export const INDIA = /india/i
export const BUTCHER = /butcher/i
export const BREAD = /bread/i
export const TRIP = { from: 4, to: 16 }
export const BUTCHER_DAY = 21
/** The butcher reminders: 2 days before, and the day before. */
export const BUTCHER_REMINDER_DAYS = () => [dayFromNow(BUTCHER_DAY - 2), dayFromNow(BUTCHER_DAY - 1)]

export const fixtures: Fixtures = {
  triage: (t: string) =>
    INDIA.test(t)
      ? request({ asksBaumy: true, olympics: 'calendar_add' })
      : BUTCHER.test(t)
        ? reminderAsk({ asksBaumy: true, worthRemembering: true, olympics: 'calendar_add' })
        : BREAD.test(t)
          ? reminderAsk({ asksBaumy: true })
          : chatter(),
  olympics: (t: string, _call: ModelCall) =>
    INDIA.test(t)
      ? { op: 'calendar_add', title: 'Ryan in India', date: dayFromNow(TRIP.from), endDate: dayFromNow(TRIP.to), startTime: '', endTime: '' }
      : BUTCHER.test(t)
        ? { op: 'calendar_add', title: 'Butcher delivery', date: dayFromNow(BUTCHER_DAY), endDate: dayFromNow(BUTCHER_DAY + 1), startTime: '', endTime: '' }
        : null,
  reminder: (t: string) => {
    if (BUTCHER.test(t)) {
      const [twoBefore, dayBefore] = BUTCHER_REMINDER_DAYS()
      return [
        reminder({ content: 'the butcher delivery is in 2 days', when: '2 days before', fireAt: `${twoBefore}T09:00`, forWhom: 'house' }),
        reminder({ content: 'the butcher delivery is tomorrow', when: 'the day before', fireAt: `${dayBefore}T09:00`, forWhom: 'house' }),
      ]
    }
    if (BREAD.test(t)) {
      // "in 2 minutes", to the minute: it fires 1–2 minutes from now.
      return reminder({ content: 'take the bread out of the oven', when: 'in 2 minutes', fireAt: local(DateTime.now().setZone(TZ).plus({ minutes: 2 })), forWhom: 'speaker' })
    }
    return null
  },
  reply: () => 'Done 😼',
}
