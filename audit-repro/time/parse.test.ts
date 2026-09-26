// AUDIT REPRO (time/dates): how parseWhen / parseEventDate resolve the phrases house chat actually
// uses. Each `it` asserts the CURRENT (buggy) behaviour, so a passing test == the bug is present.
import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { parseWhen, parseEventDate, clampToWakingHours } from '@/lib/reminders/parse'

const TZ = 'Europe/Berlin'
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ })
const local = (d: Date) => DateTime.fromJSDate(d).setZone(TZ).toFormat('ccc yyyy-LL-dd HH:mm')

describe('parseWhen (live capture path: whenText -> event_at, and reminders)', () => {
  it('"this weekend" said ON a Saturday resolves to NEXT Saturday (a week late)', () => {
    // Charli, Saturday 14:00: "Zuzka is staying in my room this weekend" -> whenText "this weekend"
    const p = parseWhen('this weekend', TZ, at('2026-09-26T14:00:00'))!
    expect(local(p.fireAt)).toBe('Sat 2026-10-03 09:00')
    // ...and on the Sunday too
    expect(local(parseWhen('this weekend', TZ, at('2026-09-27T11:00:00'))!.fireAt)).toBe('Sat 2026-10-03 09:00')
  })

  it('forwardDate overrides an explicit PAST qualifier: "last Sunday" becomes the coming Sunday', () => {
    const p = parseWhen('last Sunday', TZ, at('2026-09-24T15:00:00'))! // Thursday
    expect(local(p.fireAt)).toBe('Sun 2026-09-27 09:00') // future, not 20 Sep
  })

  it('"the 9th" / "on the 9th" (the extractor prompt\'s OWN example) is unparseable -> null', () => {
    expect(parseWhen('the 9th', TZ, at('2026-09-24T15:00:00'))).toBeNull()
    expect(parseWhen('on the 9th', TZ, at('2026-09-24T15:00:00'))).toBeNull()
  })

  it('"at 5" said at 14:00 resolves to 05:00 TOMORROW (clamped to 06:00), not 17:00 today', () => {
    const p = parseWhen('at 5', TZ, at('2026-09-24T14:00:00'))!
    expect(local(p.fireAt)).toBe('Fri 2026-09-25 05:00')
    expect(local(clampToWakingHours(p.fireAt, TZ))).toBe('Fri 2026-09-25 06:00')
  })

  it('"tomorrow" said at 00:30 (still "tonight" for the house) skips a whole day', () => {
    const p = parseWhen('tomorrow', TZ, at('2026-09-25T00:30:00'))!
    expect(local(p.fireAt)).toBe('Sat 2026-09-26 09:00')
  })

  it('"today" / "tonight" late in the day resolve to a time already PAST (reminder fires instantly)', () => {
    const now = at('2026-09-24T23:30:00')
    expect(parseWhen('tonight', TZ, now)!.fireAt.getTime()).toBeLessThan(now.toMillis())
    expect(parseWhen('today', TZ, at('2026-09-24T14:00:00'))!.fireAt.getTime()).toBeLessThan(at('2026-09-24T14:00:00').toMillis())
  })

  it('a DURATION ("for a week") is read as a date one week out', () => {
    expect(local(parseWhen('for a week', TZ, at('2026-09-24T15:00:00'))!.fireAt)).toBe('Thu 2026-10-01 09:00')
  })

  it('"end of the month" resolves to the same day NEXT month (24 Oct), not ~30 Sep', () => {
    expect(local(parseWhen('end of the month', TZ, at('2026-09-24T15:00:00'))!.fireAt)).toBe('Sat 2026-10-24 09:00')
  })

  it('"tomorrow morning" fires at 06:00 (chrono daypart), the edge of the waking window', () => {
    expect(local(parseWhen('tomorrow morning', TZ, at('2026-09-24T15:00:00'))!.fireAt)).toBe('Fri 2026-09-25 06:00')
  })
})

describe('parseEventDate (nightly backfill path)', () => {
  it('"monday morning" recorded on a Thursday is read as the PAST Monday -> backfill skips a real future event', () => {
    const p = parseEventDate('monday morning', TZ, at('2026-09-24T15:00:00'))!
    expect(local(p.fireAt)).toBe('Mon 2026-09-21 06:00') // in the past -> consolidation `continue`s
  })
})
