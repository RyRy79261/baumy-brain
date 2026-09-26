import { eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { reminders } from '@/db/schema'
import {
  claimReminder,
  markSent,
  dueScheduled,
  releaseReminder,
  reapStaleFiring,
  expireStaleScheduled,
  cancelReminder,
  loadSeriesRow,
  scheduleNextOccurrence,
  repairRecurringSeries,
} from '@/lib/reminders/store'
import { headsUpAtDelivery } from '@/lib/inngest/functions/surfacing'
import { sendToHouseResilient } from '@/lib/telegram/house-send'
import { getHouseChatId } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { houseTz } from '@/lib/env'
import { now } from '@/lib/core/clock'

const ARM_WINDOW_DAYS = 6 // Inngest Free caps a single sleep at 7 days
type DueRow = Awaited<ReturnType<typeof dueScheduled>>[number]

// How late a reminder may be and still be worth sending. Past this it is history, not a reminder:
// "let them in when they return tomorrow evening" delivered weeks later is noise, and the house
// cannot tell it apart from something happening now. Anything older is cancelled, not delivered.
// One digest slot of slack (a 20:00 miss still goes out at 08:00) plus room for a deploy gap.
export const STALE_AFTER_HOURS = 24
const staleBefore = (now: Date): Date => new Date(now.getTime() - STALE_AFTER_HOURS * 3_600_000)

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
      const at = now()
      const horizon = new Date(at.getTime() + ARM_WINDOW_DAYS * 86_400_000)
      // Only EXPLICIT reminders are armed for near-time sleepUntil delivery. Event heads-ups
      // (anchor_kind='event_offset') are delivered BATCHED by the daytime digest instead, so they
      // never fire at odd individual times — exclude them from arming here. The staleness floor
      // keeps a long-past backlog row from being armed and fired as if it were due now.
      const due = await dueScheduled(db, horizon, 100, staleBefore(at))
      return due.filter((r) => r.anchorKind !== 'event_offset')
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

// The explicit-reminder delivery CORE (exported for the sandbox, which drives it at the reminder's own
// instant): claim → send → mark-sent → create the next occurrence of a recurring series. The order is
// the exactly-once contract — whichever path claims first wins, the other skips; a send failure
// releases (never zero-fire); a failure after the send never releases (never double-send). "Create
// next" is an idempotent insert keyed on previous_reminder_id, and a crash right before it is healed by
// the digest's repairRecurringSeries. The staleness window applies here too: a run that wakes more than
// STALE_AFTER_HOURS late retires the reminder instead of posting old news (and keeps its series going).
export async function deliverReminderNow(
  db: ReturnType<typeof createHttpDb>,
  reminderId: string,
  at: Date,
  tz: string,
): Promise<{ status: 'sent' | 'skipped' | 'expired'; nextId?: string | null }> {
  const row = await loadSeriesRow(db, reminderId)
  if (!row) return { status: 'skipped' }
  if (new Date(row.fireAt).getTime() < staleBefore(at).getTime()) {
    await expireStaleScheduled(db, staleBefore(at), { now: at, tz })
    return { status: 'expired' }
  }
  if (!(await claimReminder(db, reminderId))) return { status: 'skipped' } // another path already claimed it
  try {
    // Destination resolved in code to the CURRENT live house id (self-heals a supergroup
    // migration — the frozen deliver_chat_id may predate it). Fixed-destination invariant intact.
    await sendToHouseResilient(db, reminderBody(row.anchorKind, row.content))
  } catch (e) {
    await releaseReminder(db, reminderId) // SEND failed → back to scheduled so it retries (never zero-fire)
    throw e
  }
  // Sent OK. markSent SEPARATELY — a failure here must NOT release (that would re-send);
  // it leaves the row 'firing' for the stale-firing reaper to resolve, avoiding a double-send.
  await markSent(db, reminderId)
  const nextId = row.recurrence ? await scheduleNextOccurrence(db, row, at, tz) : null
  return { status: 'sent', nextId }
}

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

    const res = await step.run('deliver', () => deliverReminderNow(createHttpDb(), reminderId, now(), houseTz()))
    // The next occurrence of a recurring series: arm it now if it falls inside the sleep window (the
    // daily arm cron would pick it up anyway — this only saves a day's latency for a daily series).
    if (res.nextId) {
      const next = await step.run('load-next', async () => {
        const [r] = await createHttpDb().select({ fireAt: reminders.fireAt }).from(reminders).where(eq(reminders.id, res.nextId!)).limit(1)
        return r ? new Date(r.fireAt).toISOString() : null
      })
      if (next && new Date(next).getTime() - now().getTime() < ARM_WINDOW_DAYS * 86_400_000)
        await step.sendEvent('arm-next', { id: `reminder-arm:${res.nextId}`, name: 'reminder/arm.due', data: { reminderId: res.nextId } })
    }
    return { delivered: reminderId, status: res.status }
  },
)

// Digest (docs/spec/reminders.md) — REPLACES the old every-30-min poll. A batched heads-up at
// WAKING-hour slots only (never 02:00–06:00): once/day = a morning batch, twice/day = morning +
// evening (~12h apart), owner-settable via reminder_frequency. Each run reaps stuck reminders then
// delivers every DUE reminder — the batched event heads-ups (event_offset, which are NOT armed for
// near-time delivery) plus any explicit reminder the sleepUntil path missed — as ONE message per
// destination, claim-once. So it's both the event-surfacing delivery AND the explicit-reminder
// backstop, at 1–2 wakes/day instead of ~48. (Explicit reminders still fire near their time via
// reminderDeliver; claimReminder gates exactly-once between the two paths.)
// The digest's delivery CORE (exported for testing): reap stuck reminders, then deliver every DUE
// reminder as ONE message per destination, claim-once. Claiming first is the exactly-once guard vs
// the sleepUntil path — whichever claims a row wins; the other skips it. A send failure releases the
// whole batch back to 'scheduled' so the next slot retries (never a zero-fire, never a double-send).
export async function deliverDueReminders(
  db: ReturnType<typeof createHttpDb>,
  now: Date,
  tz: string = houseTz(),
): Promise<{ sent: number; messages: number; expired: number }> {
  await reapStaleFiring(db, new Date(now.getTime() - 10 * 60_000))
  // A recurring series whose "create next" never ran (a crash after mark-sent) gets its next occurrence.
  await repairRecurringSeries(db, now, tz)
  // Retire anything too late to be news BEFORE selecting — so a backlog is dropped, never flushed
  // into the group. Logged, never silent (audit trail lives in the cancelled rows). A retired
  // recurring occurrence still schedules its next one.
  const expired = await expireStaleScheduled(db, staleBefore(now), { now, tz })
  if (expired > 0) console.warn(`reminder-digest: retired ${expired} stale reminder(s) (>${STALE_AFTER_HOURS}h past due)`)
  const due = await dueScheduled(db, now, 100, staleBefore(now))
  // Batch by destination (all reminders target the house group, but group defensively).
  const byDest = new Map<string, DueRow[]>()
  for (const r of due) byDest.set(r.deliverChatId, [...(byDest.get(r.deliverChatId) ?? []), r])

  let sent = 0
  let messages = 0
  // All reminders deliver to the house group; the destination is resolved in code at send time to the
  // CURRENT live id (sendToHouseResilient) — so a supergroup migration self-heals even if a row's
  // frozen deliver_chat_id predates it. The byDest grouping stays as a defensive batch boundary.
  for (const group of byDest.values()) {
    const claimed: DueRow[] = []
    for (const r of group) if (await claimReminder(db, r.id)) claimed.push(r)
    if (claimed.length === 0) continue
    // Event heads-ups are WRITTEN NOW, for this delivery instant (T11): the lead is the real one, a
    // moved/ended/forgotten event is dropped, and one event never posts two stages in one digest (the
    // latest-scheduled stage wins; the others are retired with it). A transient model error releases
    // the whole batch so the next slot retries.
    const lines = new Map<string, string>() // reminder id → posted text
    const dropped: string[] = []
    try {
      const events = new Map<string, DueRow>()
      for (const r of [...claimed].sort((a, b) => new Date(b.fireAt).getTime() - new Date(a.fireAt).getTime())) {
        if (r.anchorKind !== 'event_offset') {
          lines.set(r.id, r.content)
          continue
        }
        const h = await headsUpAtDelivery(db, r.eventFactId ?? null, now, tz)
        if (h.line === null || (h.key && events.has(h.key))) {
          if (h.line === null) console.warn(`reminder-digest: heads-up ${r.id} dropped at delivery (${h.reason})`)
          dropped.push(r.id)
          continue
        }
        events.set(h.key, r)
        lines.set(r.id, h.line)
      }
    } catch (e) {
      for (const r of claimed) await releaseReminder(db, r.id)
      throw e
    }
    for (const id of dropped) await cancelReminder(db, id)
    const toSend = claimed.filter((r) => lines.has(r.id)).sort((a, b) => new Date(a.fireAt).getTime() - new Date(b.fireAt).getTime())
    if (toSend.length === 0) continue
    const body = toSend.map((r) => reminderBody(r.anchorKind, lines.get(r.id)!)).join('\n')
    try {
      await sendToHouseResilient(db, body)
    } catch (e) {
      for (const r of toSend) await releaseReminder(db, r.id)
      throw e
    }
    for (const r of toSend) {
      await markSent(db, r.id) // per-row; a stuck one is reaped next slot
      // What was actually posted — /reminders history and the dashboard show the delivered line.
      if (r.anchorKind === 'event_offset' && lines.get(r.id) !== r.content) await db.update(reminders).set({ content: lines.get(r.id)! }).where(eq(reminders.id, r.id))
      if (r.recurrence) {
        const row = await loadSeriesRow(db, r.id)
        if (row) await scheduleNextOccurrence(db, row, now, tz)
      }
    }
    sent += toSend.length
    messages += 1
  }
  return { sent, messages, expired }
}

// Digest (docs/spec/reminders.md) — REPLACES the old every-30-min poll. A batched heads-up at
// WAKING-hour slots only (never 02:00–06:00): once/day = a morning batch, twice/day = morning +
// evening (~12h apart), owner-settable via reminder_frequency. Delivers the batched event heads-ups
// (event_offset, NOT armed for near-time) plus any explicit reminder the sleepUntil path missed —
// so it's both the event-surfacing delivery AND the explicit-reminder backstop, at 1–2 wakes/day
// instead of ~48. Honors /pause (proactive output).
export const reminderDigest = inngest.createFunction(
  { id: 'reminder-digest' },
  { cron: 'TZ=Europe/Berlin 0 8,20 * * *' }, // 08:00 + 20:00 house tz; the 20:00 slot is gated on frequency
  async ({ step }) => {
    return step.run('digest', async () => {
      const db = createHttpDb()
      const houseChatId = await getHouseChatId(db)
      if (!houseChatId) return { skipped: 'no-house' as const }
      const policy = await loadResponsePolicy(db)
      if (!policy.global_enabled) return { skipped: 'paused' as const } // proactive output honors /pause
      // 'once' a day = the morning slot only; the 20:00 run no-ops.
      const at = now()
      const eveningSlot = DateTime.fromJSDate(at).setZone(houseTz()).hour >= 14
      if (policy.reminder_frequency === 'once' && eveningSlot) return { skipped: 'once-morning-only' as const }
      return deliverDueReminders(db, at, houseTz())
    })
  },
)
