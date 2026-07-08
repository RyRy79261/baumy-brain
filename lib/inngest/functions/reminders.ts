import { eq } from 'drizzle-orm'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { reminders } from '@/db/schema'
import { claimReminder, markSent, dueScheduled, releaseReminder, reapStaleFiring } from '@/lib/reminders/store'
import { sendToHouse } from '@/lib/telegram/client'

const ARM_WINDOW_DAYS = 6 // Inngest Free caps a single sleep at 7 days

// Delivery framing: an explicit "remind me" reminder posts as ⏰; a proactive event-surfacing
// heads-up (anchor_kind='event_offset', docs/spec/event-surfacing.md) posts as 🗓️ so it reads as
// advance notice, not an alarm. Same delivery machinery — only the prefix differs.
const reminderBody = (anchorKind: string | undefined, content: string): string =>
  `${anchorKind === 'event_offset' ? '🗓️' : '⏰'} ${content}`

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

// Deliver (task-graph R3): sleep until fire_at, then atomically claim + send once. A
// cancelled reminder is gated out by claimReminder (it only claims status='scheduled'), so
// the sleeping run harmlessly no-ops — no cancel event is needed or emitted.
export const reminderDeliver = inngest.createFunction(
  { id: 'reminder-deliver' },
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
        await sendToHouse(row.deliverChatId, reminderBody(row.anchorKind, row.content))
      } catch (e) {
        await releaseReminder(db, reminderId) // SEND failed → back to scheduled so it retries (never zero-fire)
        throw e
      }
      // Sent OK. markSent SEPARATELY — a failure here must NOT release (that would re-send);
      // it leaves the row 'firing' for the stale-firing reaper to resolve, avoiding a double-send.
      await markSent(db, reminderId)
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
        if (!(await claimReminder(db, r.id))) continue
        try {
          await sendToHouse(r.deliverChatId, reminderBody(r.anchorKind, r.content))
        } catch {
          await releaseReminder(db, r.id) // send failed → return to scheduled for the next sweep
          continue
        }
        await markSent(db, r.id) // failure leaves it 'firing' for the reaper, not an immediate re-send
        count++
      }
      return count
    })
    return { swept: sent }
  },
)
