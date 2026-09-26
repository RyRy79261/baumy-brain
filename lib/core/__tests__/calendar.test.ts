import { describe, it, expect } from 'vitest'
import { messageSentLine, calendarTable, timeContext, formatEventWindow, CALENDAR_DAYS } from '@/lib/core/calendar'

// The time anchor the fact + reminder extractors are given (spec §6): MESSAGE SENT in the house tz and
// a 21-day calendar table, so the model LOOKS UP "friday" instead of computing it (T3/T4/T8).
const TZ = 'Europe/Berlin'
const at = new Date('2026-09-26T19:40:00Z') // Sat 26 Sep 2026, 21:40 Berlin

describe('calendar', () => {
  it('MESSAGE SENT is the house-local time, with the zone named', () => {
    expect(messageSentLine(at, TZ)).toBe('MESSAGE SENT: Sat 26 Sep 2026 21:40 Europe/Berlin')
  })

  it('the table has 21 rows from yesterday, weekday + ISO date, with yesterday/today/tomorrow marked', () => {
    const rows = calendarTable(at, TZ)
    expect(rows).toHaveLength(CALENDAR_DAYS)
    expect(rows.slice(0, 4)).toEqual(['Fri 2026-09-25 (yesterday)', 'Sat 2026-09-26 (today)', 'Sun 2026-09-27 (tomorrow)', 'Mon 2026-09-28'])
    expect(rows.at(-1)).toBe('Thu 2026-10-15')
  })

  it('"today" is the HOUSE date — 00:30 Berlin is still UTC yesterday', () => {
    expect(calendarTable(new Date('2026-09-25T22:30:00Z'), TZ)[1]).toBe('Sat 2026-09-26 (today)')
  })

  it('timeContext = the line + the table, as one block', () => {
    const block = timeContext(at, TZ).split('\n')
    expect(block[0]).toBe('MESSAGE SENT: Sat 26 Sep 2026 21:40 Europe/Berlin')
    expect(block[1]).toMatch(/^CALENDAR/)
    expect(block).toContain('  Fri 2026-10-02')
  })

  it('formatEventWindow: a day, a timed start, a multi-day range — never the default +6h end', () => {
    expect(formatEventWindow(new Date('2026-10-02T22:00:00Z'), new Date('2026-10-03T21:59:59.999Z'), TZ)).toBe('Sat 3 Oct')
    expect(formatEventWindow(new Date('2026-10-02T22:00:00Z'), new Date('2026-10-04T21:59:59.999Z'), TZ)).toBe('Sat 3 Oct – Sun 4 Oct')
    expect(formatEventWindow(new Date('2026-10-03T20:00:00Z'), new Date('2026-10-04T02:00:00Z'), TZ)).toBe('Sat 3 Oct 22:00')
    expect(formatEventWindow(new Date('2026-10-03T20:00:00Z'), null, TZ, { year: true })).toBe('Sat 3 Oct 2026 22:00')
  })
})
