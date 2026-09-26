import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { resolveWhen, eventWindowFromModel, eventWindowFromPhrase, fireAtFromModel, reminderTimeFromPhrase } from '@/lib/core/when'

// The time resolver's fixed defaults (docs/spec/chat-understanding-v2.md §6). Each case is an audit
// finding's scenario, asserting the CORRECT reading (the repros in audit-repro/time asserted the bugs).
const TZ = 'Europe/Berlin'
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ })
const local = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).toFormat('ccc yyyy-LL-dd HH:mm')
const read = (text: string, now: string) => {
  const r = resolveWhen(text, { tz: TZ, now: at(now) })
  return r ? { start: local(r.start), end: r.end ? local(r.end) : null, allDay: r.allDay, exact: r.exactTime } : null
}
const fire = (text: string, now: string) => {
  const t = reminderTimeFromPhrase(text, TZ, at(now).toJSDate())
  return t ? local(t.fireAt) : null
}

describe('resolveWhen — house talk, read the way the house means it', () => {
  it('T4: "friday around 10pm" / "friday ~10pm" keep the time of day (split chrono hits are merged)', () => {
    expect(fire('friday around 10pm', '2026-09-23T10:30')).toBe('Fri 2026-09-25 22:00')
    expect(fire('friday ~10pm', '2026-09-23T10:30')).toBe('Fri 2026-09-25 22:00')
    expect(fire('around 10pm friday', '2026-09-23T10:30')).toBe('Fri 2026-09-25 22:00')
  })

  it('T4: slashed dates are day/month in a European house ("9/10" = 9 October)', () => {
    expect(read('9/10', '2026-09-23T10:30')?.start).toBe('Fri 2026-10-09 00:00')
  })

  it('T4: a lead time is the anchor minus the offset — even when that is already past (the caller clarifies)', () => {
    expect(read('a week before friday', '2026-09-23T10:30')?.start).toBe('Fri 2026-09-18 00:00')
    expect(read('3 days before friday', '2026-09-23T10:30')?.start).toBe('Tue 2026-09-22 00:00')
    expect(fire('2 hours before saturday 9pm', '2026-09-23T10:30')).toBe('Sat 2026-09-26 19:00')
  })

  it('T9: a bare hour is the NEXT time it comes round, never the 02:00–06:00 dead zone', () => {
    expect(fire('at 5', '2026-09-24T14:00')).toBe('Thu 2026-09-24 17:00') // not 05:00 tomorrow
    expect(fire('at 5', '2026-09-24T18:30')).toBe('Fri 2026-09-25 17:00') // 05:00 is the dead zone
    expect(fire('at 10', '2026-09-24T09:00')).toBe('Thu 2026-09-24 10:00')
    expect(fire('at 10', '2026-09-24T11:00')).toBe('Thu 2026-09-24 22:00')
    expect(fire('friday at 5', '2026-09-24T09:00')).toBe('Fri 2026-09-25 17:00') // with a day, 1–7 means pm
    expect(fire('friday at 10', '2026-09-24T09:00')).toBe('Fri 2026-09-25 10:00')
  })

  it('T10: dayparts keep their meaning — morning is 09:00, not chrono\'s 06:00', () => {
    expect(fire('tomorrow morning', '2026-09-24T15:00')).toBe('Fri 2026-09-25 09:00')
    expect(fire('tomorrow evening', '2026-09-24T15:00')).toBe('Fri 2026-09-25 20:00')
    expect(fire('monday afternoon', '2026-09-24T15:00')).toBe('Mon 2026-09-28 15:00')
  })

  it('T7: the same weekday said ON that day is today; "this weekend" on a weekend is THIS weekend', () => {
    expect(read('saturday', '2026-09-26T08:00')?.start).toBe('Sat 2026-09-26 00:00')
    expect(read('this weekend', '2026-09-26T14:00')).toEqual({ start: 'Sat 2026-09-26 00:00', end: 'Sun 2026-09-27 23:59', allDay: true, exact: false })
    expect(read('this weekend', '2026-09-27T11:00')?.start).toBe('Sat 2026-09-26 00:00')
    expect(read('this weekend', '2026-09-24T14:00')?.end).toBe('Sun 2026-09-27 23:59')
    // …but a time already gone that day is a week on
    expect(fire('thursday 9am', '2026-09-24T14:00')).toBe('Thu 2026-10-01 09:00')
  })

  it('T7: a past marker is read literally, never rolled forward', () => {
    expect(read('last sunday', '2026-09-24T15:00')?.start).toBe('Sun 2026-09-20 00:00')
    expect(read('yesterday', '2026-09-24T15:00')?.start).toBe('Wed 2026-09-23 00:00')
  })

  it('T8: "the 9th" / "on the 9th" is the next 9th of a month (and reads the time around it)', () => {
    expect(read('the 9th', '2026-09-24T15:00')?.start).toBe('Fri 2026-10-09 00:00')
    expect(read('on the 9th', '2026-09-24T15:00')?.start).toBe('Fri 2026-10-09 00:00')
    expect(fire('on the 3rd at 9am', '2026-07-01T10:00')).toBe('Fri 2026-07-03 09:00')
    expect(read('the 31st', '2026-09-24T15:00')?.start).toBe('Sat 2026-10-31 00:00') // September has no 31st
  })

  it('T10: "tomorrow" after midnight is the day that is dawning (documented rule)', () => {
    expect(read('tomorrow', '2026-09-25T00:30')?.start).toBe('Fri 2026-09-25 00:00')
    expect(read('tomorrow', '2026-09-25T09:00')?.start).toBe('Sat 2026-09-26 00:00')
  })

  it('T10: a duration is not a time; "end of the month" is its last day', () => {
    expect(read('for a week', '2026-09-24T15:00')).toBeNull()
    expect(read('for 3 days', '2026-09-24T15:00')).toBeNull()
    expect(read('end of the month', '2026-09-24T15:00')?.start).toBe('Wed 2026-09-30 00:00')
  })

  it('"every friday at 8pm" reads as the first occurrence (the rule itself is the recurrence field)', () => {
    expect(fire('every friday at 8pm', '2026-09-28T10:00')).toBe('Fri 2026-10-02 20:00')
  })

  it('not a time at all → null', () => {
    expect(read('the extra room', '2026-09-24T15:00')).toBeNull()
    expect(read('when Zosia lands', '2026-09-24T15:00')).toBeNull()
  })
})

describe('reminderTimeFromPhrase — defaults are flagged, so a gone default asks instead of firing', () => {
  it('a bare date fires at 09:00 and is flagged as a defaulted time', () => {
    const t = reminderTimeFromPhrase('friday', TZ, at('2026-09-24T15:00').toJSDate())!
    expect(local(t.fireAt)).toBe('Fri 2026-09-25 09:00')
    expect(t.timeDefaulted).toBe(true)
  })
  it('"tonight" at 23:30 resolves to a past default — the caller turns that into a question', () => {
    const t = reminderTimeFromPhrase('tonight', TZ, at('2026-09-24T23:30').toJSDate())!
    expect(t.fireAt.getTime()).toBeLessThan(at('2026-09-24T23:30').toMillis())
    expect(t.timeDefaulted).toBe(true)
  })
  it('an explicit clock time is not a default', () => {
    expect(reminderTimeFromPhrase('friday 8pm', TZ, at('2026-09-24T15:00').toJSDate())!.timeDefaulted).toBe(false)
  })
})

describe('validating what the MODEL resolved (spec §6)', () => {
  const now = at('2026-09-26T21:40').toJSDate()

  it('a stay "this weekend" → event_at = Saturday 00:00, valid_to = end of Sunday', () => {
    const w = eventWindowFromModel({ start: '2026-10-03', end: '2026-10-04', allDay: true }, TZ, now)!
    expect(local(w.eventAt)).toBe('Sat 2026-10-03 00:00')
    expect(local(w.validTo)).toBe('Sun 2026-10-04 23:59')
  })

  it('valid_to defaults: an all-day day ends that night, a timed event lasts 6h', () => {
    expect(local(eventWindowFromModel({ start: '2026-10-09', allDay: true }, TZ, now)!.validTo)).toBe('Fri 2026-10-09 23:59')
    const w = eventWindowFromModel({ start: '2026-10-03T22:00', allDay: false }, TZ, now)!
    expect(local(w.eventAt)).toBe('Sat 2026-10-03 22:00')
    expect(local(w.validTo)).toBe('Sun 2026-10-04 04:00')
  })

  it('a date-only start is all-day even when the model omits (or contradicts) the allDay flag', () => {
    // Read as a timed event at local midnight, it expired at 06:00 on the day itself.
    const w = eventWindowFromModel({ start: '2026-10-03' }, TZ, now)!
    expect(local(w.eventAt)).toBe('Sat 2026-10-03 00:00')
    expect(local(w.validTo)).toBe('Sat 2026-10-03 23:59')
    expect(local(eventWindowFromModel({ start: '2026-10-03', allDay: false }, TZ, now)!.validTo)).toBe('Sat 2026-10-03 23:59')
    expect(local(eventWindowFromModel({ start: '2026-10-03', end: '2026-10-04' }, TZ, now)!.validTo)).toBe('Sun 2026-10-04 23:59')
  })

  it('rejects the unparseable and the absurd; drops an end before the start', () => {
    expect(eventWindowFromModel({ start: 'next saturday', allDay: true }, TZ, now)).toBeNull()
    expect(eventWindowFromModel({ start: '2031-01-01', allDay: true }, TZ, now)).toBeNull() // > 2 years out
    const w = eventWindowFromModel({ start: '2026-10-04', end: '2026-10-03', allDay: true }, TZ, now)!
    expect(local(w.validTo)).toBe('Sun 2026-10-04 23:59') // the bad end is ignored, the default applies
  })

  it('a past event is kept (it dates the history), and a phrase-only fact uses the fallback', () => {
    expect(eventWindowFromModel({ start: '2026-09-19', end: '2026-09-20', allDay: true }, TZ, now)).not.toBeNull()
    expect(local(eventWindowFromPhrase('this weekend', TZ, at('2026-09-24T19:00').toJSDate())!.eventAt)).toBe('Sat 2026-09-26 00:00')
    expect(eventWindowFromPhrase('for a week', TZ, now)).toBeNull()
  })

  it('fireAt: local ISO in the house zone; a date alone fires at 09:00; junk → null', () => {
    expect(local(fireAtFromModel('2026-10-02T22:00', TZ, now)!)).toBe('Fri 2026-10-02 22:00')
    expect(local(fireAtFromModel('2026-10-09', TZ, now)!)).toBe('Fri 2026-10-09 09:00')
    expect(fireAtFromModel('', TZ, now)).toBeNull()
    expect(fireAtFromModel('friday', TZ, now)).toBeNull()
    expect(fireAtFromModel('2029-10-02T22:00', TZ, now)).toBeNull()
  })

  it('DST-correct: the same wall-clock time in winter is an hour later in UTC', () => {
    expect(fireAtFromModel('2026-07-10T09:00', TZ, now)!.toISOString()).toBe('2026-07-10T07:00:00.000Z')
    expect(fireAtFromModel('2026-12-10T09:00', TZ, now)!.toISOString()).toBe('2026-12-10T08:00:00.000Z')
  })
})
