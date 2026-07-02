import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { parseWhen } from '@/lib/reminders/parse'

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
