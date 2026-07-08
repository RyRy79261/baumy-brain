import { describe, it, expect } from 'vitest'
import { computeNudgeStages, nudgeContent } from '@/lib/surfacing/nudge'

const tz = 'Europe/Berlin'

describe('computeNudgeStages — lead-time policy (week / day / morning)', () => {
  it('an upcoming event gets all three stages, each in the future and before the event', () => {
    const now = new Date('2026-07-01T09:00:00Z')
    const event = new Date('2026-07-08T12:00:00Z') // ~7 days out
    const stages = computeNudgeStages(event, now, tz)
    expect(stages.map((s) => s.stage)).toEqual(['week', 'day', 'morning'])
    for (const s of stages) {
      expect(s.fireAt.getTime()).toBeGreaterThan(now.getTime())
      expect(s.fireAt.getTime()).toBeLessThan(event.getTime())
    }
  })

  it('an event captured late (2 days out) gracefully skips the week stage', () => {
    const now = new Date('2026-07-08T09:00:00Z')
    const event = new Date('2026-07-10T20:00:00Z')
    expect(computeNudgeStages(event, now, tz).map((s) => s.stage)).toEqual(['day', 'morning'])
  })

  it('an event later today gets only the morning-of nudge', () => {
    const now = new Date('2026-07-10T04:00:00Z') // 06:00 CEST
    const event = new Date('2026-07-10T18:00:00Z') // 20:00 CEST same day
    expect(computeNudgeStages(event, now, tz).map((s) => s.stage)).toEqual(['morning'])
  })

  it('a past event yields nothing (never nudge after the fact)', () => {
    const now = new Date('2026-07-10T09:00:00Z')
    const event = new Date('2026-07-05T09:00:00Z')
    expect(computeNudgeStages(event, now, tz)).toEqual([])
  })
})

describe('nudgeContent — heads-up text, fresh date not the stale phrase', () => {
  const event = new Date('2026-07-09T20:00:00Z')
  it('renders subject + predicate + the resolved date, with the lead framing', () => {
    const day = nudgeContent('iman', 'staying', event, 'day', tz)
    expect(day).toContain('Iman staying, tomorrow')
    expect(day).toContain('9 Jul')
    expect(nudgeContent('rent', 'due', event, 'morning', tz)).toContain('today')
    const week = nudgeContent('zuzana', 'arrives_on', event, 'week', tz)
    expect(week).toContain('next week')
    expect(week).toContain('arrives on') // underscores → spaces
  })
})
