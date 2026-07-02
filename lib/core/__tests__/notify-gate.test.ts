import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { gateNotify } from '@/lib/core/notify-gate'

const at = (hour: number) => DateTime.fromObject({ year: 2026, month: 6, day: 10, hour }, { zone: 'Europe/Berlin' })

describe('gateNotify — fatigue control', () => {
  it('reminders always send, even inside quiet hours (P0)', () => {
    expect(gateNotify('reminder', 999, at(3))).toBe('send')
  })

  it('digest defers during quiet hours, sends otherwise', () => {
    expect(gateNotify('digest', 0, at(23))).toBe('defer')
    expect(gateNotify('digest', 0, at(10))).toBe('send')
  })

  it('nudge is suppressed over the daily cap (outside quiet hours)', () => {
    expect(gateNotify('nudge', 5, at(10))).toBe('suppress')
    expect(gateNotify('nudge', 2, at(10))).toBe('send')
  })

  it('quiet-hours window correctly crosses midnight', () => {
    expect(gateNotify('nudge', 0, at(2))).toBe('defer') // 02:00 is quiet
    expect(gateNotify('nudge', 0, at(9))).toBe('send') // 09:00 is not
  })
})
