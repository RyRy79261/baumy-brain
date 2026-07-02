import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { computeNextRun } from '@/lib/scheduled-tasks/cadence'

const bln = (d: Date) => DateTime.fromJSDate(d).setZone('Europe/Berlin')
const from = (day: number, hour: number) =>
  DateTime.fromObject({ year: 2026, month: 6, day, hour }, { zone: 'Europe/Berlin' })

describe('computeNextRun', () => {
  it('daily after 09:00 → tomorrow 09:00', () => {
    const n = bln(computeNextRun('daily', from(10, 12))!)
    expect(n.day).toBe(11)
    expect(n.hour).toBe(9)
  })
  it('daily before 09:00 → today 09:00', () => {
    const n = bln(computeNextRun('daily', from(10, 6))!)
    expect(n.day).toBe(10)
    expect(n.hour).toBe(9)
  })
  it('mid-week → a Wednesday at 09:00', () => {
    const n = bln(computeNextRun('mid-week', from(8, 12))!)
    expect(n.weekday).toBe(3)
    expect(n.hour).toBe(9)
  })
  it('end-of-week → a Sunday at 17:00', () => {
    const n = bln(computeNextRun('end-of-week', from(8, 12))!)
    expect(n.weekday).toBe(7)
    expect(n.hour).toBe(17)
  })
  it('every:7d → +7 days', () => {
    const n = bln(computeNextRun('every:7d', from(10, 12))!)
    expect(n.day).toBe(17)
  })
  it('unknown cadence → null', () => {
    expect(computeNextRun('bogus', DateTime.now())).toBeNull()
  })
})
