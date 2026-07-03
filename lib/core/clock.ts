import { houseTz } from '@/lib/env'

// Today's date in the house timezone, so a model can resolve relative dates ("next week",
// "this weekend", "over the next month"). Without a concrete "today" it cannot reason about
// time at all. Shared by the reply path and the on-demand reports.
export function houseToday(now: Date = new Date()): string {
  const d = new Intl.DateTimeFormat('en-GB', {
    timeZone: houseTz(),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
  return `${d} (house time, ${houseTz()})`
}
