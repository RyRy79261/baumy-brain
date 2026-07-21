import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { parseWhen, clampToWakingHours } from '@/lib/reminders/parse'

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
})
