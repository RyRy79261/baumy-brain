import { DateTime } from 'luxon'

// The cron table — the ONE place a scheduled job's timing lives. Production registers each entry as an
// Inngest cron function (lib/inngest/functions/crons.ts for the one-step jobs; the multi-step ones read
// their cron from here with cronOf); the sandbox (lib/sandbox/harness.ts) reads the SAME table to know
// what fires when on its simulated clock. Before this table, the harness restated the schedule by hand
// and drifted from it.
//
// Pure data: no imports from the jobs, so any function file may read it without an import cycle.
//
// `id` is the Inngest function id — never rename one (Inngest keys a function's runs and history on
// it). `sandbox` says whether a sandbox advance runs the job at its simulated firings, or why not.

export interface ScheduleEntry {
  id: string
  /** Inngest cron syntax; an optional `TZ=<zone>` prefix, else UTC. */
  cron: string
  retries?: 0 | 1 | 2 | 3
  sandbox: true | { skip: string }
}

export const SCHEDULE = [
  // Privacy bound, not proactive output: not held by /pause. Every window read also filters by 48h.
  { id: 'conversation-window-purge', cron: '17 * * * *', retries: 2, sandbox: true },
  // Nightly graph hygiene (F12): after the day's traffic, before the 07:45 scan reads the facts.
  { id: 'memory-hygiene', cron: 'TZ=Europe/Berlin 40 3 * * *', retries: 1, sandbox: true },
  // Ahead of the morning scan, so a same-night catch-up is already dated by 07:45.
  { id: 'end-of-day-consolidate', cron: 'TZ=Europe/Berlin 30 22 * * *', retries: 1, sandbox: true },
  // 07:45 — just BEFORE the 08:00 digest, so a morning-of heads-up is due at 08:00 (T11).
  { id: 'event-surfacing-scan', cron: 'TZ=Europe/Berlin 45 7 * * *', sandbox: true },
  // 08:00 + 20:00; the 20:00 slot is gated on reminder_frequency inside the job.
  { id: 'reminder-digest', cron: 'TZ=Europe/Berlin 0 8,20 * * *', sandbox: true },
  {
    id: 'reminder-arm',
    cron: 'TZ=Europe/Berlin 5 0 * * *',
    sandbox: { skip: 'arms sleepUntil runs; the sandbox delivers each explicit reminder at its own instant instead' },
  },
  {
    id: 'reflect-sweep',
    cron: '0 */6 * * *',
    retries: 1,
    sandbox: { skip: 'a model call per housemate, and a profile would change what every later scenario turn is grounded on' },
  },
  // DAILY, not every 10 min: steady state is a no-op SELECT, and a 10-min cron kept Neon from scaling to zero.
  { id: 'reembed-sweep', cron: '0 4 * * *', sandbox: { skip: 'only has work after an embedder swap' } },
] as const satisfies readonly ScheduleEntry[]

export type ScheduleId = (typeof SCHEDULE)[number]['id']

export function scheduleEntry(id: ScheduleId): ScheduleEntry {
  return SCHEDULE.find((e) => e.id === id)!
}

export const cronOf = (id: ScheduleId): string => scheduleEntry(id).cron

// --- Firings: when a cron fires between two instants (the sandbox's clock) ----------------------------
//
// The subset of cron the table uses: minute and hour fields as `*`, `*/n`, `n` or `a,b,c`; day-of-month,
// month and day-of-week must be `*`. Anything else throws, so a new entry the sandbox cannot play is
// caught by the schedule test, not silently skipped.

function field(spec: string, max: number): number[] {
  if (spec === '*') return Array.from({ length: max }, (_, i) => i)
  const step = /^\*\/(\d+)$/.exec(spec)
  if (step) return Array.from({ length: max }, (_, i) => i).filter((i) => i % Number(step[1]) === 0)
  const values = spec.split(',').map((v) => (/^\d+$/.test(v) ? Number(v) : NaN))
  if (values.some((v) => Number.isNaN(v) || v >= max)) throw new Error(`[schedule] unsupported cron field "${spec}"`)
  return values
}

export function parseCron(cron: string): { zone: string; minutes: number[]; hours: number[] } {
  const tz = /^TZ=(\S+)\s+/.exec(cron)
  const rest = (tz ? cron.slice(tz[0].length) : cron).trim().split(/\s+/)
  if (rest.length !== 5) throw new Error(`[schedule] expected 5 cron fields: "${cron}"`)
  const [m, h, dom, mon, dow] = rest
  if (dom !== '*' || mon !== '*' || dow !== '*') throw new Error(`[schedule] only daily-shaped crons are supported: "${cron}"`)
  return { zone: tz ? tz[1] : 'UTC', minutes: field(m, 60), hours: field(h, 24) }
}

/** Every instant `cron` fires strictly after `from` and at or before `to`, in order. */
export function firingsOf(cron: string, from: Date, to: Date): Date[] {
  const { zone, minutes, hours } = parseCron(cron)
  const out: Date[] = []
  const end = DateTime.fromJSDate(to).setZone(zone).endOf('day')
  for (let day = DateTime.fromJSDate(from).setZone(zone).startOf('day'); day <= end; day = day.plus({ days: 1 })) {
    for (const hour of hours)
      for (const minute of minutes) {
        const at = day.set({ hour, minute, second: 0, millisecond: 0 })
        // A wall time a DST jump skips is normalised forward by luxon; drop it rather than fire twice.
        if (at.hour !== hour || at.minute !== minute) continue
        const t = at.toMillis()
        if (t > from.getTime() && t <= to.getTime()) out.push(at.toJSDate())
      }
  }
  return out.sort((a, b) => a.getTime() - b.getTime())
}
