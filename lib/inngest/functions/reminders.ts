import { eq } from 'drizzle-orm'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { reminders } from '@/db/schema'
import { claimReminder, markSent, dueScheduled, releaseReminder, reapStaleFiring } from '@/lib/reminders/store'
import { sendToHouse } from '@/lib/telegram/client'

const ARM_WINDOW_DAYS = 6 // Inngest Free caps a single sleep at 7 days

// Daily arm (task-graph R2): emit an arm.due event for each scheduled reminder
// entering the ≤6-day window. One cheap run/day — nowhere near the exec budget.
export const reminderArm = inngest.createFunction(
  { id: 'reminder-arm' },
  { cron: 'TZ=Europe/Berlin 5 0 * * *' },
  async ({ step }) => {
    const rows = await step.run('find-due', async () => {
      const db = createHttpDb()
      const horizon = new Date(Date.now() + ARM_WINDOW_DAYS * 86_400_000)
      return dueScheduled(db, horizon)
    })
    if (rows.length > 0) {
      await step.sendEvent(
        'arm',
        rows.map((r) => ({ name: 'reminder/arm.due' as const, data: { reminderId: r.id } })),
      )
    }
    return { armed: rows.length }
  },
)

// Deliver (task-graph R3): sleep until fire_at, then atomically claim + send once.
// Cancelled reminders cancel the sleeping run via cancelOn.
export const reminderDeliver = inngest.createFunction(
  { id: 'reminder-deliver', cancelOn: [{ event: 'reminder/cancelled', match: 'data.reminderId' }] },
  { event: 'reminder/arm.due' },
  async ({ event, step }) => {
    const { reminderId } = event.data

    const row = await step.run('load', async () => {
      const db = createHttpDb()
      const [r] = await db.select().from(reminders).where(eq(reminders.id, reminderId)).limit(1)
      return r ?? null
    })
    if (!row || row.status !== 'scheduled') return { skipped: true }

    await step.sleepUntil('until-due', new Date(row.fireAt))

    await step.run('deliver', async () => {
      const db = createHttpDb()
      if (!(await claimReminder(db, reminderId))) return // another path already claimed it
      try {
        await sendToHouse(row.deliverChatId, `⏰ ${row.content}`)
        await markSent(db, reminderId)
      } catch (e) {
        await releaseReminder(db, reminderId) // send failed → back to scheduled so it retries (never zero-fire)
        throw e
      }
    })
    return { delivered: reminderId }
  },
)

// Sweeper (task-graph R3 backstop): a coarse catch-up for anything missed,
// redeployed-through, or beyond the arm window. Every 15 min ≈ 2.9k runs/mo.
export const reminderSweeper = inngest.createFunction(
  { id: 'reminder-sweeper' },
  { cron: '*/15 * * * *' },
  async ({ step }) => {
    const sent = await step.run('sweep', async () => {
      const db = createHttpDb()
      // Reap reminders orphaned in 'firing' (process died mid-send) older than 10 min.
      await reapStaleFiring(db, new Date(Date.now() - 10 * 60_000))
      const overdue = await dueScheduled(db, new Date())
      let count = 0
      for (const r of overdue) {
        if (await claimReminder(db, r.id)) {
          try {
            await sendToHouse(r.deliverChatId, `⏰ ${r.content}`)
            await markSent(db, r.id)
            count++
          } catch {
            await releaseReminder(db, r.id) // failed → return to scheduled for the next sweep
          }
        }
      }
      return count
    })
    return { swept: sent }
  },
)
