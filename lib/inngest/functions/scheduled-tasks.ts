import { DateTime } from 'luxon'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { resolveModel } from '@/lib/ai/registry'
import { deliberate } from '@/lib/ai/deliberate'
import { dueTasks, recordRun } from '@/lib/scheduled-tasks/store'
import { computeNextRun } from '@/lib/scheduled-tasks/cadence'
import { buildDigest } from '@/lib/scheduled-tasks/digest'
import { sendToHouse } from '@/lib/telegram/client'

// The SINGLE shared scheduled-task dispatcher (scheduled-tasks.md ST2). Inngest
// crons are static, so one hourly cron fans out over the durable table — there
// is no per-task cron. Digests are just is_system rows with prompt='digest'.
export const scheduledTaskDispatch = inngest.createFunction(
  { id: 'scheduled-task-dispatch' },
  { cron: 'TZ=Europe/Berlin 0 * * * *' },
  async ({ step }) => {
    const ran = await step.run('dispatch', async () => {
      const db = createHttpDb()
      const due = await dueTasks(db, new Date())
      for (const t of due) {
        const text =
          t.isSystem && t.prompt === 'digest'
            ? await buildDigest(db, t.groupId)
            : await deliberate(t.prompt, resolveModel(t.modelTier === 'advisor' ? 'advisor' : 'assess'))
        await sendToHouse(t.groupId, text)
        const next = computeNextRun(t.cadence, DateTime.now())
        await recordRun(db, t.id, next, (t.untilExpiry as Date | null) ?? null)
      }
      return due.length
    })
    return { ran }
  },
)
