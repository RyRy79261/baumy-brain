import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { type TelegramMessageData } from '@/lib/inngest/client'
import { runIngest } from '@/lib/inngest/functions/ingest'
import { runCallback } from '@/lib/inngest/functions/callback'
import { deliverDueReminders, deliverReminderNow } from '@/lib/inngest/functions/reminders'
import { runEventSurfacingScan } from '@/lib/inngest/functions/surfacing'
import { runConsolidationSweep } from '@/lib/inngest/functions/consolidation'
import { purgeWindow } from '@/lib/turn/window'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { and, asc, eq, gt, lte, ne, notInArray } from 'drizzle-orm'
import { houseConfig, reminders } from '@/db/schema'
import { withSimulatedTime } from '@/lib/core/clock'
import { captureOutbound, type OutboundMessage } from '@/lib/telegram/outbox'
import { SANDBOX_BOT_ID, SANDBOX_BOT_USERNAME } from '@/lib/telegram/client'

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
  /** @deprecated alias of `replyToBaumy: true`. */
  replyToBot?: boolean
  /** Reply to one of BAUMY's messages (makes it "directed"). A string is the text of the Baumy
   *  message being replied to (forwarded as context, like Telegram's reply_to_message). */
  replyToBaumy?: boolean | string
  /** Reply to someone else's message: a sandbox person (`who`), or a raw transport author (`fromId`
   *  / `isBot`, e.g. another bot in the group — C8), optionally the forum topic-root service
   *  message (`isTopicRoot` — C9: Telegram sets it on every message in a topic). */
  replyTo?: { who?: string | number; fromId?: number | null; isBot?: boolean; forwarded?: boolean; text?: string | null; isTopicRoot?: boolean }
  /** @-mention Baumy: prefixes the text with "@baumy_bot " (C12 — the token must never reach memory). */
  mention?: boolean
  /** Post as an anonymous group admin: from = @GroupAnonymousBot, sender_chat = the house (I8). */
  anonymousAdmin?: boolean
  /** Forum topic the message sits in (message_thread_id). */
  threadId?: number
  /** Reuse an earlier message's id — how Telegram delivers an EDIT (a new update, same message_id;
   *  the webhook forwards edited_message like any message — I1). Defaults to a fresh id. */
  messageId?: number
}

/** Telegram's fixed identity for anonymous-admin posts. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824

/**
 * Say something as one of the sandbox's people, at the current simulated time, and return
 * everything Baumy did in response.
 */
export async function sendAs(sb: Sandbox, who: string | number, text: string, opts: SendOptions = {}): Promise<TranscriptEntry[]> {
  const person = findPerson(sb, who)

  const updateId = sb.seq++
  const anon = opts.anonymousAdmin === true && !opts.dm
  const event: { data: TelegramMessageData } = {
    data: {
      updateId,
      messageId: opts.messageId ?? updateId,
      // The lane is derived from chat type + ids by the real origin resolver — the sandbox supplies
      // transport facts, exactly like Telegram would, and never asserts a trust level directly.
      chatId: opts.dm ? String(person.id) : sb.houseChatId,
      chatType: opts.dm ? 'private' : 'supergroup',
      fromId: anon ? GROUP_ANONYMOUS_BOT_ID : person.id,
      fromFirstName: anon ? 'Group' : person.name,
      fromLastName: null,
      fromUsername: anon ? 'GroupAnonymousBot' : null,
      text: opts.mention ? `@${SANDBOX_BOT_USERNAME} ${text}` : text,
      messageThreadId: opts.dm ? null : (opts.threadId ?? null),
      isBot: anon,
      isForwarded: opts.forwarded ?? false,
      senderChatId: anon ? sb.houseChatId : null,
      ...replyFields(sb, opts),
    },
  }

  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runIngest(event, inlineStep)))
  const entries = sent.map((m) => ({ ...m, cause: `${person.name}: ${text}` }))
  sb.transcript.push(...entries)
  return entries
}

/**
 * Tap a confirm card's button as one of the sandbox's people — the callback_query half of the
 * confirm-tap wall (docs/spec/chat-understanding-v2.md §8, A1). `actionId` is the card's pending
 * action id (a captured confirm card carries it as `meta`); `chatId` is where the card was sent (the
 * house group or the tapper's DM). Drives the real callback handler; returns what Baumy did.
 */
export async function tapAs(
  sb: Sandbox,
  who: string | number,
  actionId: string,
  opts: { verb?: 'confirm' | 'cancel'; chatId?: string; messageId?: number } = {},
): Promise<TranscriptEntry[]> {
  const person = findPerson(sb, who)
  const updateId = sb.seq++
  const data = {
    callbackId: `cb${updateId}`,
    fromId: person.id,
    chatId: opts.chatId ?? sb.houseChatId,
    messageId: opts.messageId ?? updateId,
    data: `${opts.verb === 'cancel' ? 'x' : 'c'}:${actionId}`,
  }
  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runCallback({ data }, inlineStep)))
  const entries = sent.map((m) => ({ ...m, cause: `${person.name}: tap ${opts.verb ?? 'confirm'}` }))
  sb.transcript.push(...entries)
  return entries
}

function findPerson(sb: Sandbox, who: string | number): SandboxPerson {
  const person = sb.people.find((p) => p.id === who || p.name.toLowerCase() === String(who).toLowerCase())
  if (!person) throw new Error(`[sandbox] no such person: ${who}. Known: ${sb.people.map((p) => p.name).join(', ')}`)
  return person
}

// The reply_to_message transport facts, exactly as the webhook forwards them (C8/C9).
function replyFields(sb: Sandbox, opts: SendOptions): Pick<TelegramMessageData, 'replyToBot' | 'replyToMessage'> {
  const toBaumy = opts.replyToBaumy ?? opts.replyToBot
  if (toBaumy) {
    // The Baumy message being replied to: the latest one with that text (or simply the latest one),
    // so its synthetic message id links the reply in the conversation window like Telegram's would.
    const text = typeof toBaumy === 'string' ? toBaumy : null
    const said = [...sb.transcript].reverse().find((e) => (e.kind === 'message' || e.kind === 'confirm-card') && (text == null || e.text === text))
    return {
      replyToBot: true,
      replyToMessage: { fromId: SANDBOX_BOT_ID, isBot: true, text, isTopicRoot: false, messageId: said?.messageId ?? null },
    }
  }
  if (opts.replyTo) {
    const r = opts.replyTo
    const target = r.who != null ? findPerson(sb, r.who) : null
    const isBot = target ? false : (r.isBot ?? false)
    return {
      replyToBot: isBot,
      replyToMessage: {
        fromId: target ? target.id : (r.fromId ?? null),
        isBot,
        isForwarded: r.forwarded ?? false,
        text: r.text ?? null,
        isTopicRoot: r.isTopicRoot ?? false,
      },
    }
  }
  return { replyToBot: false, replyToMessage: null }
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
    // The conversation window's 48h purge (production runs it hourly; once a day is enough here, as
    // every window read also filters by 48h). Driven at its own simulated instant like every job.
    id: 'window-purge',
    hour: 4,
    minute: 17,
    run: async (sb, at) => {
      await purgeWindow(sb.db, at)
    },
  },
  {
    id: 'consolidation',
    hour: 22,
    minute: 30,
    run: async (sb, at) => {
      await runConsolidationSweep(sb.db, sb.houseChatId, at, sb.tz)
    },
  },
  {
    // 07:45, like production: just before the 08:00 digest, so a morning-of heads-up is due at 08:00.
    id: 'surfacing-scan',
    hour: 7,
    minute: 45,
    run: async (sb, at) => {
      await runEventSurfacingScan(sb.db, sb.houseChatId, at, sb.tz)
    },
  },
  {
    id: 'digest-morning',
    hour: 8,
    minute: 0,
    run: async (sb, at) => {
      await deliverDueReminders(sb.db, at, sb.tz)
    },
  },
  {
    id: 'digest-evening',
    hour: 20,
    minute: 0,
    run: async (sb, at) => {
      await deliverDueReminders(sb.db, at, sb.tz)
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
  // Explicit reminders fire at THEIR OWN instant — production's armed sleepUntil path (reminderDeliver),
  // with the digest as the backstop. Delivered one at a time in fire order, each before any cron due at
  // the same minute; a recurring occurrence's successor (created on delivery) is picked up in turn.
  // A reminder held by /pause stays 'scheduled' (production leaves it for the digest after /resume) —
  // skipped for the rest of this advance so the loop cannot spin on it.
  const held = new Set<string>()
  const deliverExplicitUntil = async (limit: Date) => {
    for (;;) {
      const [next] = await sb.db
        .select({ id: reminders.id, fireAt: reminders.fireAt })
        .from(reminders)
        .where(
          and(
            eq(reminders.groupId, sb.houseChatId),
            eq(reminders.status, 'scheduled'),
            ne(reminders.anchorKind, 'event_offset'),
            gt(reminders.fireAt, from),
            lte(reminders.fireAt, limit),
            held.size ? notInArray(reminders.id, [...held]) : undefined,
          ),
        )
        .orderBy(asc(reminders.fireAt))
        .limit(1)
      if (!next) return
      const at = new Date(next.fireAt)
      let status = ''
      const { sent } = await captureOutbound(async () =>
        withSimulatedTime(at, async () => {
          status = (await deliverReminderNow(sb.db, next.id, at, sb.tz)).status
        }),
      )
      if (status === 'paused') held.add(next.id)
      const said = sent.map((m) => ({ ...m, cause: 'reminder' }))
      sb.transcript.push(...said)
      fired.push({ job: 'reminder', at, said })
      sb.now = at
    }
  }
  for (const { at, job } of firingsBetween(from, to, sb.tz)) {
    await deliverExplicitUntil(at)
    const { sent } = await captureOutbound(async () => withSimulatedTime(at, () => job.run(sb, at)))
    const said = sent.map((m) => ({ ...m, cause: `cron:${job.id}` }))
    sb.transcript.push(...said)
    fired.push({ job: job.id, at, said })
    sb.now = at
  }
  await deliverExplicitUntil(to)
  sb.now = to
  return { from, to, fired }
}

/** Convenience: advance by a duration instead of to an absolute instant. */
export const advanceBy = (sb: Sandbox, opts: { days?: number; hours?: number; minutes?: number }): Promise<AdvanceResult> =>
  advanceTo(sb, DateTime.fromJSDate(sb.now).plus(opts).toJSDate())

/** Just the lines Baumy actually posted to the group, for a readable assertion or a UI transcript. */
export const spoken = (entries: TranscriptEntry[]): string[] =>
  entries.filter((e) => e.kind === 'message' && e.text).map((e) => e.text as string)
