import { test } from 'vitest'
import { DateTime } from 'luxon'
import { parseWhen, parseEventDate } from '@/lib/reminders/parse'
test('x', () => {
  const tz='Europe/Berlin'
  for (const [t, n] of [['this weekend','2026-09-26T08:00'],['this weekend','2026-09-26T14:00'],['this weekend','2026-09-24T14:00'],['saturday','2026-09-26T08:00'],['at 5','2026-09-24T14:00'],['5','2026-09-24T14:00'],['the 9th','2026-09-24T14:00'],['October 9th','2026-09-24T14:00'],['9th','2026-09-24T14:00'],['tonight','2026-09-24T23:30'],['for a week','2026-09-24T14:00'],['end of the month','2026-09-24T14:00'],['last sunday','2026-09-24T14:00'],['tomorrow','2026-09-25T00:30']] as const) {
    const r = parseWhen(t, tz, DateTime.fromISO(n,{zone:tz}))
    console.log(t, '@', n, '=>', r?.resolvedLocal)
  }
  console.log('monday morning backfill', parseEventDate('monday morning', tz, DateTime.fromISO('2026-09-24T14:00',{zone:tz}))?.resolvedLocal)
  console.log('monday backfill', parseEventDate('monday', tz, DateTime.fromISO('2026-09-24T14:00',{zone:tz}))?.resolvedLocal)
  console.log('on monday backfill', parseEventDate('on monday', tz, DateTime.fromISO('2026-09-24T14:00',{zone:tz}))?.resolvedLocal)
})
