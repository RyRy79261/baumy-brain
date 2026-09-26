import { describe, it, expect } from 'vitest'
import { computeNudgeStages, groupEvents, leadAt, leadFor, nudgeStageOf, whenLabel } from '@/lib/surfacing/nudge'
import { sanitiseHeadsUp } from '@/lib/ai/nudge'

const tz = 'Europe/Berlin'

describe('computeNudgeStages — lead-time policy, pinned to digest slots (T11)', () => {
  const local = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)

  it('an upcoming event gets all three stages — 08:00 a week before, 20:00 the evening before, 08:00 on the day', () => {
    const now = new Date('2026-07-01T05:45:00Z') // Wed 07:45 (the scan)
    const event = new Date('2026-07-08T12:00:00Z') // Wed 8 Jul 14:00
    const stages = computeNudgeStages(event, now, tz)
    expect(stages.map((s) => s.stage)).toEqual(['week', 'day', 'morning'])
    expect(stages.map((s) => local(s.fireAt))).toEqual(['Wed 1, 08:00', 'Tue 7, 20:00', 'Wed 8, 08:00'])
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

  it('an early-morning event (07:00) gets no after-the-fact morning nudge — the evening before covers it', () => {
    const now = new Date('2026-07-08T09:00:00Z')
    const event = new Date('2026-07-10T05:00:00Z') // Fri 07:00
    expect(computeNudgeStages(event, now, tz).map((s) => s.stage)).toEqual(['day'])
  })

  it('an ALL-DAY event (local midnight start) still gets its morning-of nudge', () => {
    const now = new Date('2026-07-08T09:00:00Z')
    const event = new Date('2026-07-09T22:00:00Z') // Sat 11 Jul, all day
    expect(computeNudgeStages(event, now, tz).map((s) => s.stage)).toEqual(['day', 'morning'])
  })

  it('a past event yields nothing (never nudge after the fact)', () => {
    const now = new Date('2026-07-10T09:00:00Z')
    const event = new Date('2026-07-05T09:00:00Z')
    expect(computeNudgeStages(event, now, tz)).toEqual([])
  })
})

describe('nudgeStageOf — which stage an existing row is (the scan de-dupes per event × stage)', () => {
  it('a slot-pinned row is its own stage; a pre-slot offset (ev − 7d, ev − 24h) maps to week / day', () => {
    const ev = new Date('2026-10-08T08:00:00Z') // Thu 8 Oct 10:00
    for (const s of computeNudgeStages(ev, new Date('2026-09-30T00:00:00Z'), tz)) expect(nudgeStageOf(s.fireAt, ev, tz)).toBe(s.stage)
    expect(nudgeStageOf(new Date(ev.getTime() - 7 * 86_400_000), ev, tz)).toBe('week')
    expect(nudgeStageOf(new Date(ev.getTime() - 86_400_000), ev, tz)).toBe('day')
    // Even for a late-night event the old ev − 24h (Wed 23:30) is the evening slot, not the morning one.
    const late = new Date('2026-10-08T21:30:00Z') // Thu 23:30
    expect(nudgeStageOf(new Date(late.getTime() - 86_400_000), late, tz)).toBe('day')
  })
})

describe('leadAt — the lead as of the moment the line is POSTED (T11)', () => {
  const party = new Date('2026-10-03T20:00:00Z') // Sat 3 Oct 22:00 Berlin
  it('reads the real distance from delivery, in house-tz calendar days', () => {
    expect(leadAt(party, new Date('2026-10-02T18:00:00Z'), tz)).toBe('tomorrow') // Fri 20:00
    expect(leadAt(party, new Date('2026-10-03T06:00:00Z'), tz)).toBe('tonight') // Sat 08:00 — NOT "tomorrow"
    expect(leadAt(party, new Date('2026-09-30T06:00:00Z'), tz)).toBe('on Saturday (in 3 days)')
    expect(leadAt(party, new Date('2026-09-26T06:00:00Z'), tz)).toBe('next week')
    expect(leadAt(new Date('2026-10-03T08:00:00Z'), new Date('2026-10-03T06:00:00Z'), tz)).toBe('today') // a 10:00 thing, at 08:00
  })
  it('null once a timed event has started, or an all-day one is over — dropped, never posted late', () => {
    expect(leadAt(party, new Date('2026-10-03T20:30:00Z'), tz)).toBeNull()
    const allDay = new Date('2026-10-02T22:00:00Z') // Sat 3 Oct, all day
    expect(leadAt(allDay, new Date('2026-10-03T18:00:00Z'), tz)).toBe('today') // Sat 20:00 — still that day
    expect(leadAt(allDay, new Date('2026-10-04T06:00:00Z'), tz)).toBeNull()
  })
})

describe('lead framing — fresh date, never the fact\'s stale phrase', () => {
  const event = new Date('2026-07-09T20:00:00Z')
  it('labels the scheduled lead and renders the date (+ time for a timed event) from event_at', () => {
    expect(leadFor('week')).toBe('next week')
    expect(leadFor('day')).toBe('tomorrow')
    expect(leadFor('morning')).toBe('today')
    expect(whenLabel(event, tz)).toBe('Thu 9 Jul, 22:00')
    expect(whenLabel(new Date('2026-07-08T22:00:00Z'), tz)).toBe('Thu 9 Jul') // all day
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
