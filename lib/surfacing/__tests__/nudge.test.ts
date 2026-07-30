import { describe, it, expect } from 'vitest'
import { computeNudgeStages, groupEvents, leadFor, whenLabel } from '@/lib/surfacing/nudge'
import { sanitiseHeadsUp } from '@/lib/ai/nudge'

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

describe('lead framing — fresh date, never the fact\'s stale phrase', () => {
  const event = new Date('2026-07-09T20:00:00Z')
  it('labels the lead and renders the date from event_at', () => {
    expect(leadFor('week')).toBe('next week')
    expect(leadFor('day')).toBe('tomorrow')
    expect(leadFor('morning')).toBe('today')
    expect(whenLabel(event, tz)).toBe('Thu 9 Jul')
  })
})

describe('groupEvents — one heads-up per EVENT, not per extracted triple', () => {
  const day = (iso: string) => new Date(iso)
  it('collapses several facts about the same subject on the same day into one group', () => {
    // The shape that produced five stub lines from one message: one arrival, three triples.
    const groups = groupEvents(
      [
        { id: 'b', subjectEntityId: 'ryan', eventAt: day('2026-07-30T18:00:00Z') },
        { id: 'a', subjectEntityId: 'ryan', eventAt: day('2026-07-30T09:00:00Z') },
        { id: 'c', subjectEntityId: 'ryan', eventAt: day('2026-07-30T21:00:00Z') },
      ],
      tz,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].facts.map((f) => f.id)).toEqual(['a', 'b', 'c']) // earliest first
    expect(groups[0].anchor.id).toBe('a') // stable anchor = earliest, id as tiebreak
    expect(groups[0].eventAt).toEqual(day('2026-07-30T09:00:00Z'))
  })

  it('keeps different people, and the same person on different days, separate', () => {
    const groups = groupEvents(
      [
        { id: '1', subjectEntityId: 'ryan', eventAt: day('2026-07-30T09:00:00Z') },
        { id: '2', subjectEntityId: 'tilly', eventAt: day('2026-07-30T09:00:00Z') },
        { id: '3', subjectEntityId: 'ryan', eventAt: day('2026-08-02T09:00:00Z') },
      ],
      tz,
    )
    expect(groups).toHaveLength(3)
  })
})

describe('sanitiseHeadsUp — deterministic disposal of the written line', () => {
  it('keeps a normal sentence, trimming stray bullets and whitespace', () => {
    expect(sanitiseHeadsUp(' • Zuzana lands tomorrow evening\n')).toBe('Zuzana lands tomorrow evening')
  })

  it('SKIP means nothing gets scheduled', () => {
    expect(sanitiseHeadsUp('SKIP')).toBeNull()
    expect(sanitiseHeadsUp('skip')).toBeNull()
    expect(sanitiseHeadsUp('   ')).toBeNull()
  })

  it('collapses newlines — a multi-line answer must not forge extra digest entries', () => {
    // The digest joins reminders with "\n"; an unsanitised line could fake a second heads-up.
    expect(sanitiseHeadsUp('Bins go out tonight\n🗓️ Rent is due tomorrow')).toBe('Bins go out tonight 🗓️ Rent is due tomorrow')
  })

  it('drops a runaway line rather than truncating it mid-sentence', () => {
    expect(sanitiseHeadsUp('x'.repeat(400))).toBeNull()
  })
})
