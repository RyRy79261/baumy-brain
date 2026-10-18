import { inngest } from '@/lib/inngest/client'
import { createHttpDb, type Database } from '@/db/client'
import { now } from '@/lib/core/clock'
import { houseTz } from '@/lib/env'
import { scheduleEntry } from '@/lib/inngest/schedule'
import { runReminderDigest } from '@/lib/inngest/functions/reminders'
import { runSurfacingJob } from '@/lib/inngest/functions/surfacing'
import { runConsolidationJob } from '@/lib/inngest/functions/consolidation'
import { runHygieneJob } from '@/lib/inngest/functions/hygiene'
import { runWindowPurgeJob } from '@/lib/inngest/functions/window'

// The one-step scheduled JOBS: id (lib/inngest/schedule.ts) → the job, run at an instant. Each job owns
// its own gates (no house yet, /pause, reminder_frequency) — so production and the sandbox, which both
// call it from here, can never disagree about whether a paused house posts. `step` is the Inngest step
// name (kept stable across this refactor).
export interface CronJob {
  step: string
  run: (db: Database, at: Date, tz: string) => Promise<unknown>
}

export const CRON_JOBS = {
  'conversation-window-purge': { step: 'purge', run: (db, at) => runWindowPurgeJob(db, at) },
  'memory-hygiene': { step: 'hygiene', run: (db, at) => runHygieneJob(db, at) },
  'end-of-day-consolidate': { step: 'consolidate', run: runConsolidationJob },
  'event-surfacing-scan': { step: 'scan', run: runSurfacingJob },
  'reminder-digest': { step: 'digest', run: runReminderDigest },
} as const satisfies Record<string, CronJob>

export type CronJobId = keyof typeof CRON_JOBS

// Registered with Inngest (lib/inngest/functions/index.ts), timed by the schedule table.
export const cronFunctions = (Object.keys(CRON_JOBS) as CronJobId[]).map((id) => {
  const entry = scheduleEntry(id)
  const job: CronJob = CRON_JOBS[id]
  return inngest.createFunction(
    { id, ...(entry.retries != null ? { retries: entry.retries } : {}) },
    { cron: entry.cron },
    async ({ step }) => step.run(job.step, () => job.run(createHttpDb(), now(), houseTz())),
  )
})
