import { describe, it, expect } from 'vitest'
import {
  buildEventInput,
  choreBlocked,
  listRange,
  matchChore,
  normaliseTime,
  renderEvents,
  renderStandings,
  tapResultLine,
  failureLine,
  LINK_FIRST,
  NOT_CONNECTED,
  UNAVAILABLE,
  type ChoreView,
  type OlympicsPending,
} from '@/lib/olympics/intents'

// The deterministic half of the Olympics intents: what the extractor's slots may become (validated
// event input, a resolved chore), and every line Baumy says about it.

const TZ = 'Europe/Berlin'
const NOW = new Date('2026-10-01T16:00:00Z') // Thu 1 Oct 2026, 18:00 Berlin

describe('buildEventInput — an event is validated before it is ever proposed', () => {
  it('"dinner with Anna Saturday 19:00" → a timed event with a one-hour default end', () => {
    const d = buildEventInput({ title: 'Dinner with Anna', date: '2026-10-03', startTime: '19:00' }, NOW, TZ)
    expect(d).toEqual({
      ok: true,
      input: { title: 'Dinner with Anna', kind: 'timed', date: '2026-10-03', startTime: '19:00', endTime: '20:00' },
      when: 'Sat 3 Oct, 19:00–20:00',
    })
  })
  it('no time of day → an all-day event; a span keeps its last day', () => {
    expect(buildEventInput({ title: 'Mum visits', date: '2026-10-03', endDate: '2026-10-05' }, NOW, TZ)).toEqual({
      ok: true,
      input: { title: 'Mum visits', kind: 'all_day', date: '2026-10-03', endDate: '2026-10-05' },
      when: 'Sat 3 Oct – Mon 5 Oct, all day',
    })
  })
  it('an end before the start runs past midnight; 23:30 with no end ends the next day', () => {
    const a = buildEventInput({ title: 'Party', date: '2026-10-03', startTime: '22:00', endTime: '01:00' }, NOW, TZ)
    expect(a.ok && a.input).toMatchObject({ endDate: '2026-10-04', endTime: '01:00' })
    const b = buildEventInput({ title: 'Late one', date: '2026-10-03', startTime: '23:30' }, NOW, TZ)
    expect(b.ok && b.input).toMatchObject({ endDate: '2026-10-04', endTime: '00:30' })
  })
  it('keeps a location, trims the title', () => {
    const d = buildEventInput({ title: '  Plumber  ', date: '2026-10-02', startTime: '10:00', endTime: '11:30', location: 'Kitchen' }, NOW, TZ)
    expect(d.ok && d.input).toEqual({ title: 'Plumber', kind: 'timed', date: '2026-10-02', startTime: '10:00', endTime: '11:30', location: 'Kitchen' })
  })
  it('refuses what cannot be right: no title, no/bad date, the past, too far out', () => {
    expect(buildEventInput({ title: '', date: '2026-10-03' }, NOW, TZ)).toEqual({ ok: false, reason: 'no_title' })
    expect(buildEventInput({ title: 'X', date: '' }, NOW, TZ)).toEqual({ ok: false, reason: 'no_date' })
    expect(buildEventInput({ title: 'X', date: 'saturday' }, NOW, TZ)).toEqual({ ok: false, reason: 'bad_date' })
    expect(buildEventInput({ title: 'X', date: '2026-02-30' }, NOW, TZ)).toEqual({ ok: false, reason: 'bad_date' })
    expect(buildEventInput({ title: 'X', date: '2026-10-03', endDate: '2026-10-01' }, NOW, TZ)).toEqual({ ok: false, reason: 'bad_date' })
    expect(buildEventInput({ title: 'X', date: '2026-09-30' }, NOW, TZ)).toEqual({ ok: false, reason: 'past' })
    expect(buildEventInput({ title: 'X', date: '2026-10-01', startTime: '17:00' }, NOW, TZ)).toEqual({ ok: false, reason: 'past' })
    expect(buildEventInput({ title: 'X', date: '2029-01-01' }, NOW, TZ)).toEqual({ ok: false, reason: 'too_far' })
  })
  it('today, later → fine', () => {
    expect(buildEventInput({ title: 'X', date: '2026-10-01', startTime: '20:00' }, NOW, TZ).ok).toBe(true)
  })
  it('normalises a time or drops it', () => {
    expect(normaliseTime('7:05')).toBe('07:05')
    expect(normaliseTime('19.00')).toBe('19:00')
    expect(normaliseTime('19:00:00')).toBe('19:00')
    expect(normaliseTime('25:00')).toBeNull()
    expect(normaliseTime('7pm')).toBeNull()
  })
})

describe('listRange', () => {
  it('defaults to the next week; one day when only `from` is said; clamps to 62 days', () => {
    expect(listRange({}, NOW, TZ)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(listRange({ from: '2026-10-03' }, NOW, TZ)).toEqual({ from: '2026-10-03', to: '2026-10-03' })
    expect(listRange({ from: '2026-10-03', to: '2026-10-04' }, NOW, TZ)).toEqual({ from: '2026-10-03', to: '2026-10-04' })
    expect(listRange({ from: '2026-10-03', to: '2026-10-01' }, NOW, TZ)).toEqual({ from: '2026-10-03', to: '2026-10-03' })
    expect(listRange({ from: '2026-10-01', to: '2027-10-01' }, NOW, TZ)).toEqual({ from: '2026-10-01', to: '2026-12-02' })
    expect(listRange({ from: 'garbage' }, NOW, TZ)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
  })
})

const chore = (name: string, o: Partial<ChoreView> = {}): ChoreView => ({
  id: `id-${name}`,
  name,
  archived: false,
  basePoints: 5,
  state: 'due',
  availableAt: null,
  next: { totalPts: 5, streakLen: 1 },
  ...o,
})

describe('matchChore — the model describes, code resolves to exactly one listed chore', () => {
  const chores = [chore('Take out the trash'), chore('Dishes'), chore('Vacuum living room'), chore('Vacuum stairs'), chore('Old one', { archived: true })]
  it('matches on the words that name the chore', () => {
    expect(matchChore(chores, 'trash')).toMatchObject({ kind: 'one', chore: { name: 'Take out the trash' } })
    expect(matchChore(chores, 'the dishes')).toMatchObject({ kind: 'one', chore: { name: 'Dishes' } })
    expect(matchChore(chores, 'vacuumed the living room')).toMatchObject({ kind: 'one', chore: { name: 'Vacuum living room' } })
  })
  it('ambiguous when two chores match equally; none when nothing does; archived chores never match', () => {
    expect(matchChore(chores, 'vacuum')).toMatchObject({ kind: 'ambiguous' })
    expect(matchChore(chores, 'windows')).toEqual({ kind: 'none' })
    expect(matchChore(chores, 'old one')).toEqual({ kind: 'none' })
    expect(matchChore(chores, '')).toEqual({ kind: 'none' })
  })
  it('a chore cooling down or without points gets no card', () => {
    expect(choreBlocked(chore('Dishes'), NOW, TZ)).toBeNull()
    expect(choreBlocked(chore('Dishes', { state: 'cooldown', availableAt: '2026-10-01T18:30:00Z' }), NOW, TZ)).toMatch(/from 20:30/)
    expect(choreBlocked(chore('Dishes', { state: 'unavailable', basePoints: null }), NOW, TZ)).toMatch(/can't be scored yet/)
  })
})

describe('rendering', () => {
  it('the calendar', () => {
    expect(renderEvents({ from: '2026-10-03', to: '2026-10-03', events: [] }, TZ)).toBe('Nothing on the house calendar for Sat 3 Oct. 📅')
    const text = renderEvents(
      {
        from: '2026-10-03',
        to: '2026-10-04',
        events: [
          { id: 'e', title: 'Party', location: 'Roof', allDay: false, startDate: '2026-10-03', endDate: '2026-10-03', startTime: '21:00', endTime: '23:00', when: 'Sat 3 Oct, 21:00–23:00' },
        ],
      },
      TZ,
    )
    expect(text).toBe('📅 House calendar, Sat 3 Oct – Sun 4 Oct:\n• Sat 3 Oct, 21:00–23:00 — Party (Roof)')
  })
  it('the standings', () => {
    expect(
      renderStandings({
        season: { year: 2026 },
        leaderId: 'a',
        standings: [
          { memberId: 'a', displayName: 'Ryan', rank: 1, points: 12, provisionalPts: 4 },
          { memberId: 'b', displayName: 'Anna', rank: 2, points: 1, provisionalPts: 0 },
        ],
      }),
    ).toBe('🏆 2026 standings — Ryan leads:\n1. Ryan — 12 pts (4 still open to dispute)\n2. Anna — 1 pt')
    expect(renderStandings({ season: { year: 2026 }, leaderId: null, standings: [] })).toMatch(/No points yet/)
  })
  it('every failure is a friendly line', () => {
    expect(failureLine({ ok: false, kind: 'not_configured' })).toBe(NOT_CONNECTED)
    expect(failureLine({ ok: false, kind: 'unavailable' })).toBe(UNAVAILABLE)
    expect(failureLine({ ok: false, kind: 'refused', status: 403, code: 'TELEGRAM_NOT_LINKED', message: 'x' })).toBe(LINK_FIRST)
    expect(failureLine({ ok: false, kind: 'refused', status: 422, code: 'COOLDOWN', message: 'Too soon.' })).toBe('⚠️ Too soon.')
  })
  it('the card after the tap', () => {
    const ev: OlympicsPending = { op: 'calendar_add', name: 'create_event', input: { title: 'Dinner' }, idempotencyKey: 'brain-x1234567', summary: 'Dinner' }
    expect(tapResultLine(ev, { ok: true, data: { event: { title: 'Dinner', when: 'Sat 3 Oct, 19:00–20:00' } } })).toBe(
      '✅ Added to the house calendar: Dinner — Sat 3 Oct, 19:00–20:00',
    )
    const ch: OlympicsPending = { op: 'chore_log', name: 'log_completion', input: { choreId: 'c' }, idempotencyKey: 'brain-x1234567', summary: 'Dishes' }
    expect(tapResultLine(ch, { ok: true, data: { choreName: 'Dishes', counted: true, totalPts: 1 } })).toBe('✅ Logged: Dishes — +1 point 🧹')
    expect(tapResultLine(ch, { ok: false, kind: 'refused', status: 422, code: 'COOLDOWN', message: 'Too soon.' })).toBe('⚠️ Too soon.')
  })
})
