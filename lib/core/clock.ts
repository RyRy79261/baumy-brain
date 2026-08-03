import { AsyncLocalStorage } from 'node:async_hooks'
import { houseTz } from '@/lib/env'

// THE clock seam (docs/spec/sandbox-console.md). Production code calls now() instead of
// `new Date()` wherever the value changes behaviour, so a sandbox can run the whole system at a
// simulated instant.
//
// AsyncLocalStorage, deliberately, NOT a module-level variable: this is a Next.js server, and a
// module global would leak a sandbox's fake clock into a concurrent real request. The store is
// scoped to one async call tree; nothing outside it can see it.
//
// It is also why we do NOT use libfaketime or move the container clock — an ambient time change
// moves Postgres's own now() and leaves Inngest's scheduler on real time, so the app and the
// durable-execution engine would immediately disagree about what "now" is.
const clock = new AsyncLocalStorage<{ at: Date }>()

/** The current instant — simulated inside withSimulatedTime, the wall clock everywhere else. */
export function now(): Date {
  const store = clock.getStore()
  return store ? new Date(store.at) : new Date()
}

/** True while a simulated clock is installed — lets a caller refuse to do real-world I/O. */
export const isSimulated = (): boolean => clock.getStore() !== undefined

/** Run `fn` with now() pinned to `at`. Nested calls override for their own subtree. */
export function withSimulatedTime<T>(at: Date, fn: () => T): T {
  return clock.run({ at: new Date(at) }, fn)
}

// Today's date in the house timezone, so a model can resolve relative dates ("next week",
// "this weekend", "over the next month"). Without a concrete "today" it cannot reason about
// time at all. Shared by the reply path and the on-demand reports.
export function houseToday(at: Date = now()): string {
  const d = new Intl.DateTimeFormat('en-GB', {
    timeZone: houseTz(),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(at)
  return `${d} (house time, ${houseTz()})`
}
