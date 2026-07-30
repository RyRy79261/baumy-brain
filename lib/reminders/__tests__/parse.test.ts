import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { parseWhen, parseEventDate, clampToWakingHours } from '@/lib/reminders/parse'

const TZ = 'Europe/Berlin'
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate()
const hourIn = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).hour

describe('clampToWakingHours (6am–2am reminding window, no 3am pings)', () => {
  it('bumps a 3:30am fire time up to 6am', () => {
    expect(hourIn(clampToWakingHours(at('2026-07-10T03:30'), TZ))).toBe(6)
  })
  it('bumps exactly 2am up to 6am (dead zone starts at 02:00)', () => {
    expect(hourIn(clampToWakingHours(at('2026-07-10T02:00'), TZ))).toBe(6)
  })
  it('leaves 1am alone (still inside the 6am–2am window)', () => {
    const d = at('2026-07-10T01:00')
    expect(clampToWakingHours(d, TZ)).toEqual(d)
  })
  it('leaves a normal 9am alone', () => {
    const d = at('2026-07-10T09:00')
    expect(clampToWakingHours(d, TZ)).toEqual(d)
  })
})

describe('parseWhen — DST-correct NL time resolution', () => {
  it('summer reminder resolves to CEST (+2): 9am local = 07:00 UTC', () => {
    const now = DateTime.fromObject({ year: 2026, month: 7, day: 1, hour: 12 }, { zone: 'Europe/Berlin' })
    const p = parseWhen('in 3 days at 9am', 'Europe/Berlin', now)
    expect(p).not.toBeNull()
    expect(p!.resolvedLocal).toContain('GMT+2')
    expect(p!.fireAt.getUTCHours()).toBe(7)
  })

  it('winter reminder resolves to CET (+1): 9am local = 08:00 UTC', () => {
    const now = DateTime.fromObject({ year: 2026, month: 1, day: 1, hour: 12 }, { zone: 'Europe/Berlin' })
    const p = parseWhen('in 3 days at 9am', 'Europe/Berlin', now)
    expect(p).not.toBeNull()
    expect(p!.resolvedLocal).toContain('GMT+1')
    expect(p!.fireAt.getUTCHours()).toBe(8)
  })

  it('resolves relative days forward from the house "today"', () => {
    const now = DateTime.fromObject({ year: 2026, month: 6, day: 10, hour: 12 }, { zone: 'Europe/Berlin' })
    const p = parseWhen('in 3 days at 9am', 'Europe/Berlin', now)
    expect(p!.resolvedLocal).toContain('13 June 2026')
  })

  it('returns null for a non-time message', () => {
    expect(parseWhen('we are out of oat milk')).toBeNull()
  })

  it('honours the time of day instead of defaulting to 09:00', () => {
    const now = DateTime.fromObject({ year: 2026, month: 7, day: 20, hour: 12 }, { zone: TZ })
    // "tomorrow evening" used to resolve to 09:00 — chrono knows it means 20:00, we now keep it.
    expect(hourIn(parseWhen('tomorrow evening', TZ, now)!.fireAt)).toBe(20)
    expect(hourIn(parseWhen('friday morning', TZ, now)!.fireAt)).toBe(6)
    expect(hourIn(parseWhen('next tuesday', TZ, now)!.fireAt)).toBe(9) // no time given → 09:00
  })
})

describe('parseEventDate — precision-first re-reading of a STORED fact value', () => {
  const recorded = DateTime.fromObject({ year: 2026, month: 7, day: 20, hour: 12 }, { zone: TZ }) // a Monday

  it('resolves a real date phrase against when it was recorded', () => {
    expect(parseEventDate('in 5 days', TZ, recorded)!.resolvedLocal).toContain('25 July 2026')
    expect(parseEventDate('8 August', TZ, recorded)!.resolvedLocal).toContain('8 August 2026')
  })

  it('refuses a month name buried in prose (the profile-blob bug)', () => {
    // chrono finds "March" here and forward-dates it to next March; the coverage + known-day
    // guards mean this value is simply not a date.
    expect(parseEventDate('Owner of the house; she moved in in March and is usually away.', TZ, recorded)).toBeNull()
    expect(parseEventDate('March', TZ, recorded)).toBeNull() // a bare month is not an event date
  })

  it('refuses a past-tense aside instead of rolling it into the future', () => {
    expect(parseEventDate('was supposed to leave on Sunday', TZ, recorded)).toBeNull()
    // even the bare phrase reads literally against recorded_at (the Sunday BEFORE, i.e. past)
    expect(parseEventDate('on Sunday', TZ, recorded)!.resolvedLocal).toContain('19 July 2026')
  })

  it('refuses a long prose value outright, and a plain attribute', () => {
    expect(parseEventDate('x'.repeat(200) + ' on friday', TZ, recorded)).toBeNull()
    expect(parseEventDate('the extra room', TZ, recorded)).toBeNull()
  })
})
