import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { type TelegramMessageData } from '@/lib/inngest/client'
import { runIngest } from '@/lib/inngest/functions/ingest'
import { deliverDueReminders } from '@/lib/inngest/functions/reminders'
import { runEventSurfacingScan } from '@/lib/inngest/functions/surfacing'
import { runConsolidationSweep } from '@/lib/inngest/functions/consolidation'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { houseConfig } from '@/db/schema'
import { withSimulatedTime } from '@/lib/core/clock'
import { captureOutbound, type OutboundMessage } from '@/lib/telegram/outbox'

// The sandbox (docs/spec/sandbox-console.md Phase 2): a disposable house you can talk to as
// anyone, fast-forward, and watch.
//
// Two seams make it work, and both are enforced at the EXIT rather than by convention:
//   • withSimulatedTime pins now() for the whole async call tree, so the real code runs believing
//     it is a different instant. Nothing here fakes a clock globally — that would move Postgres's
//     own now() and leave Inngest's scheduler on real time.
//   • captureOutbound installs a sink in the Telegram transport, so a sandbox physically CANNOT
//     post to the real house group, whatever config it is holding.
//
// Time is advanced by driving the cron CORES directly, not by trying to make Inngest's scheduler
// believe in a different date. Every core already takes an explicit `now` — that was the design
// affordance that made this cheap.

export interface SandboxPerson {
  /** Stable Telegram-style id. Any number; the sandbox is its own universe. */
  id: number
  name: string
  role?: 'owner' | 'member'
}

export interface Sandbox {
  db: Database
  houseChatId: string
  /** Current simulated instant. Every action runs at this time until you advance it. */
  now: Date
  tz: string
  people: SandboxPerson[]
  /** Everything Baumy has tried to say or react with, in order, with the simulated time it happened. */
  transcript: TranscriptEntry[]
  /** Monotonic counter so each synthetic update gets a fresh id (the ingest dedupe key). */
  seq: number
}

export interface TranscriptEntry extends OutboundMessage {
  /** What triggered this — a person's message, or the cron that fired. */
  cause: string
}

export interface CreateSandboxInput {
  db: Database
  houseChatId?: string
  tz?: string
  startAt: Date
  people: SandboxPerson[]
}

// Seed a house: the group, the roster, and the house_config pointer the whole system resolves its
// destination from. Deliberately explicit rather than copied from production — a sandbox that
// inherits the real house chat id is the classic way to message real people by accident.
export async function createSandbox(input: CreateSandboxInput): Promise<Sandbox> {
  const houseChatId = input.houseChatId ?? '-100sandbox'
  const tz = input.tz ?? 'Europe/Berlin'
  await ensureRegistered(input.db, houseChatId, null)
  // Point house_config at the sandbox group, so every code path that resolves a destination
  // (sendToHouse, the digest, the surfacing scan) resolves to THIS house and not a real one.
  await input.db
    .insert(houseConfig)
    .values({ id: true, houseGroupChatId: houseChatId, houseTimezone: tz })
    .onConflictDoUpdate({ target: houseConfig.id, set: { houseGroupChatId: houseChatId, houseTimezone: tz } })
  for (const p of input.people) {
    await upsertMember(input.db, houseChatId, String(p.id), p.name, p.role ?? 'member')
  }
  return { db: input.db, houseChatId, now: new Date(input.startAt), tz, people: input.people, transcript: [], seq: 1 }
}

// A no-op Inngest step: runs each step body inline, in order. The real handler is written against
// step.run only, so this drives the ACTUAL ingest pipeline — classify, capture, extract, reconcile,
// list ops, reminders, reply — not a reimplementation of it.
const inlineStep = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() }

export interface SendOptions {
  /** Send from a private chat instead of the house group (the member_dm lane). */
  dm?: boolean
  /** Mark the message as forwarded — the quarantine path. */
  forwarded?: boolean
  /** Mark it as a reply to Baumy (makes it "directed"). */
  replyToBot?: boolean
}

/**
 * Say something as one of the sandbox's people, at the current simulated time, and return
 * everything Baumy did in response.
 */
export async function sendAs(sb: Sandbox, who: string | number, text: string, opts: SendOptions = {}): Promise<TranscriptEntry[]> {
  const person = sb.people.find((p) => p.id === who || p.name.toLowerCase() === String(who).toLowerCase())
  if (!person) throw new Error(`[sandbox] no such person: ${who}. Known: ${sb.people.map((p) => p.name).join(', ')}`)

  const updateId = sb.seq++
  const event: { data: TelegramMessageData } = {
    data: {
      updateId,
      messageId: updateId,
      // The lane is derived from chat type + ids by the real origin resolver — the sandbox supplies
      // transport facts, exactly like Telegram would, and never asserts a trust level directly.
      chatId: opts.dm ? String(person.id) : sb.houseChatId,
      chatType: opts.dm ? 'private' : 'supergroup',
      fromId: person.id,
      fromFirstName: person.name,
      fromLastName: null,
      fromUsername: null,
      text,
      isBot: false,
      isForwarded: opts.forwarded ?? false,
      replyToBot: opts.replyToBot ?? false,
    },
  }

  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runIngest(event, inlineStep)))
  const entries = sent.map((m) => ({ ...m, cause: `${person.name}: ${text}` }))
  sb.transcript.push(...entries)
  return entries
}

// The scheduled work, as (local time → core) pairs. This is the Inngest cron table restated for a
// clock we control; the schedules themselves live in createFunction and cannot be advanced from
// app code, so a sandbox drives the cores instead. Order within a day matters: consolidation runs
// the night before the morning scan, exactly as in production.
interface Job {
  id: string
  /** Local hour+minute in the house timezone. */
  hour: number
  minute: number
  run: (sb: Sandbox, at: Date) => Promise<void>
}

const JOBS: Job[] = [
  {
    id: 'consolidation',
    hour: 22,
    minute: 30,
    run: async (sb, at) => {
      await runConsolidationSweep(sb.db, sb.houseChatId, at, sb.tz)
    },
  },
  {
    id: 'surfacing-scan',
    hour: 8,
    minute: 0,
    run: async (sb, at) => {
      await runEventSurfacingScan(sb.db, sb.houseChatId, at, sb.tz)
    },
  },
  {
    id: 'digest-morning',
    hour: 8,
    minute: 0,
    run: async (sb, at) => {
      await deliverDueReminders(sb.db, at)
    },
  },
  {
    id: 'digest-evening',
    hour: 20,
    minute: 0,
    run: async (sb, at) => {
      await deliverDueReminders(sb.db, at)
    },
  },
]

// Every job firing strictly after `from` and at or before `to`, in chronological order.
function firingsBetween(from: Date, to: Date, tz: string): { at: Date; job: Job }[] {
  const out: { at: Date; job: Job }[] = []
  const start = DateTime.fromJSDate(from).setZone(tz).startOf('day')
  const end = DateTime.fromJSDate(to).setZone(tz).endOf('day')
  for (let day = start; day <= end; day = day.plus({ days: 1 })) {
    for (const job of JOBS) {
      const at = day.set({ hour: job.hour, minute: job.minute, second: 0, millisecond: 0 }).toJSDate()
      if (at.getTime() > from.getTime() && at.getTime() <= to.getTime()) out.push({ at, job })
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || JOBS.indexOf(a.job) - JOBS.indexOf(b.job))
}

export interface AdvanceResult {
  from: Date
  to: Date
  fired: { job: string; at: Date; said: TranscriptEntry[] }[]
}

/**
 * Move the sandbox clock to `to`, running every scheduled job that falls in between AT ITS OWN
 * SIMULATED TIME — not all at the end. That distinction is the whole point: a job must see the
 * instant it would really have fired at, or a fast-forward turns into one big flood at the
 * destination timestamp (the exact failure the reminder staleness window exists to prevent).
 */
export async function advanceTo(sb: Sandbox, to: Date): Promise<AdvanceResult> {
  if (to.getTime() < sb.now.getTime()) throw new Error('[sandbox] time only moves forward')
  const from = sb.now
  const fired: AdvanceResult['fired'] = []
  for (const { at, job } of firingsBetween(from, to, sb.tz)) {
    const { sent } = await captureOutbound(async () => withSimulatedTime(at, () => job.run(sb, at)))
    const said = sent.map((m) => ({ ...m, cause: `cron:${job.id}` }))
    sb.transcript.push(...said)
    fired.push({ job: job.id, at, said })
    sb.now = at
  }
  sb.now = to
  return { from, to, fired }
}

/** Convenience: advance by a duration instead of to an absolute instant. */
export const advanceBy = (sb: Sandbox, opts: { days?: number; hours?: number; minutes?: number }): Promise<AdvanceResult> =>
  advanceTo(sb, DateTime.fromJSDate(sb.now).plus(opts).toJSDate())

/** Just the lines Baumy actually posted to the group, for a readable assertion or a UI transcript. */
export const spoken = (entries: TranscriptEntry[]): string[] =>
  entries.filter((e) => e.kind === 'message' && e.text).map((e) => e.text as string)
