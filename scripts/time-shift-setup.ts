// Time-bomb check (`pnpm test:time-shift`): runs the whole suite with the WALL CLOCK moved forward, so a
// test that stores a dated fact / reminder and then reads it on the real clock fails TODAY instead of on
// the day its event expires ("current" = live — lib/memory/current.ts — judges against the clock).
// TIME_SHIFT_TO = an ISO instant to pretend it is (default: 25h from now, so a "tomorrow" crosses a day
// boundary). Only `Date` moves; code under test that pins its own instant (withSimulatedTime) is
// unaffected, which is exactly what a deterministic test should do.
const RealDate = Date
const target = process.env.TIME_SHIFT_TO ? RealDate.parse(process.env.TIME_SHIFT_TO) : RealDate.now() + 25 * 3_600_000
if (Number.isNaN(target)) throw new Error(`TIME_SHIFT_TO is not a date: ${process.env.TIME_SHIFT_TO}`)
const offset = target - RealDate.now()

class ShiftedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(RealDate.now() + offset)
    else super(...(a as [string | number | Date]))
  }
  static now(): number {
    return RealDate.now() + offset
  }
}
globalThis.Date = ShiftedDate as unknown as DateConstructor
