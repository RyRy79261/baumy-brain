import { describe, it, expect } from 'vitest'
import { SCHEDULE, firingsOf, parseCron } from '@/lib/inngest/schedule'

// The cron table is read by production AND the sandbox; the sandbox computes firings from it.
describe('schedule', () => {
  it('every cron in the table is one the sandbox can play', () => {
    for (const e of SCHEDULE) expect(() => parseCron(e.cron), e.id).not.toThrow()
  })

  it('reads a TZ prefix, lists, steps and a bare UTC cron', () => {
    expect(parseCron('TZ=Europe/Berlin 0 8,20 * * *')).toEqual({ zone: 'Europe/Berlin', minutes: [0], hours: [8, 20] })
    expect(parseCron('0 */6 * * *').hours).toEqual([0, 6, 12, 18])
    expect(parseCron('17 * * * *')).toMatchObject({ zone: 'UTC', minutes: [17] })
    expect(parseCron('17 * * * *').hours).toHaveLength(24)
  })

  it('refuses what it cannot play, instead of silently skipping it', () => {
    expect(() => parseCron('0 8 * * 1')).toThrow()
    expect(() => parseCron('0 8 1 * *')).toThrow()
    expect(() => parseCron('0 8-10 * * *')).toThrow()
    expect(() => parseCron('0 25 * * *')).toThrow()
  })

  it('fires strictly after `from` and at or before `to`, in the cron\'s zone', () => {
    const from = new Date('2026-10-18T06:00:00Z') // 08:00 Berlin (CEST) — excluded
    const to = new Date('2026-10-19T06:00:00Z') // next 08:00 Berlin — included
    expect(firingsOf('TZ=Europe/Berlin 0 8,20 * * *', from, to).map((d) => d.toISOString())).toEqual(['2026-10-18T18:00:00.000Z', '2026-10-19T06:00:00.000Z'])
    expect(firingsOf('17 * * * *', from, to)).toHaveLength(24)
  })

  it('a wall time skipped by the spring DST jump does not fire twice', () => {
    const from = new Date('2026-03-28T12:00:00Z')
    const to = new Date('2026-03-29T12:00:00Z')
    const at = firingsOf('TZ=Europe/Berlin 30 2 * * *', from, to) // 02:30 does not exist on 29 Mar in Berlin
    expect(at).toHaveLength(0)
  })
})
