import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { parseRule, normaliseRecurrence, nextOccurrence, describeRecurrence, recurrenceFromPhrase } from '@/lib/reminders/recurrence'

// RRULE-lite (spec §6, D3/A6): the extractor proposes a rule, this validates + pins it, and delivery
// steps the series one occurrence at a time.
const TZ = 'Europe/Berlin'
const local = (d: Date | null) => (d ? DateTime.fromJSDate(d).setZone(TZ).toFormat('ccc yyyy-LL-dd HH:mm') : null)
const L = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate()

describe('recurrence (RRULE-lite)', () => {
  it('accepts the lite grammar and rejects everything else', () => {
    expect(parseRule('FREQ=WEEKLY;BYDAY=FR')).toMatchObject({ freq: 'WEEKLY', byDay: [5], interval: 1 })
    expect(parseRule('RRULE:FREQ=DAILY;INTERVAL=2')).toMatchObject({ freq: 'DAILY', interval: 2 })
    for (const bad of ['', 'FREQ=YEARLY', 'FREQ=HOURLY', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=DAILY;BYDAY=MO', 'FREQ=WEEKLY;INTERVAL=0', 'FREQ=WEEKLY;COUNT=3', 'every friday'])
      expect(parseRule(bad), bad).toBeNull()
  })

  it('normalising pins the day(s) to the first occurrence, so the rule alone defines the series', () => {
    expect(normaliseRecurrence('FREQ=WEEKLY', L('2026-10-02T20:00'), TZ)).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(normaliseRecurrence('FREQ=MONTHLY', L('2026-10-31T09:00'), TZ)).toBe('FREQ=MONTHLY;BYMONTHDAY=31')
    expect(normaliseRecurrence('nonsense', L('2026-10-02T20:00'), TZ)).toBeNull()
  })

  it('weekly: the next occurrence keeps the local time across the DST change', () => {
    // Fri 23 Oct 20:00 CEST → Fri 30 Oct 20:00 CET (clocks go back on 25 Oct)
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=FR', L('2026-10-23T20:00'), L('2026-10-23T20:00'), TZ)
    expect(local(next)).toBe('Fri 2026-10-30 20:00')
  })

  it('weekly on several days, and every other week', () => {
    expect(local(nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TH', L('2026-09-28T08:00'), L('2026-09-28T08:00'), TZ))).toBe('Thu 2026-10-01 08:00')
    expect(local(nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TH', L('2026-10-01T08:00'), L('2026-10-01T08:00'), TZ))).toBe('Mon 2026-10-05 08:00')
    expect(local(nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', L('2026-10-02T20:00'), L('2026-10-02T20:00'), TZ))).toBe('Fri 2026-10-16 20:00')
  })

  it('a late delivery skips to the first occurrence after NOW (a series never posts two at once)', () => {
    expect(local(nextOccurrence('FREQ=DAILY', L('2026-10-01T09:00'), L('2026-10-04T12:00'), TZ))).toBe('Mon 2026-10-05 09:00')
  })

  it('monthly: the pinned day, clamped to a short month', () => {
    expect(local(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', L('2026-10-31T09:00'), L('2026-10-31T09:00'), TZ))).toBe('Mon 2026-11-30 09:00')
    expect(local(nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', L('2026-11-30T09:00'), L('2026-11-30T09:00'), TZ))).toBe('Thu 2026-12-31 09:00')
  })

  it('reads as words for the confirm line and /reminders', () => {
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=FR')).toBe('every Friday')
    expect(describeRecurrence('FREQ=WEEKLY;BYDAY=MO,TH')).toBe('every Monday and Thursday')
    expect(describeRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('every 2 weeks on Friday')
    expect(describeRecurrence('FREQ=MONTHLY;BYMONTHDAY=9')).toBe('every month on the 9th')
    expect(describeRecurrence('FREQ=DAILY')).toBe('every day')
    expect(describeRecurrence(null)).toBeNull()
  })

  it('the fallback reads the obvious phrases only', () => {
    expect(recurrenceFromPhrase('every friday at 8pm')).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(recurrenceFromPhrase('every day at 9')).toBe('FREQ=DAILY')
    expect(recurrenceFromPhrase('monthly')).toBe('FREQ=MONTHLY')
    expect(recurrenceFromPhrase('friday at 8pm')).toBeNull()
  })
})
