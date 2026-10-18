import { DateTime } from 'luxon'
import { type Database } from '@/db/client'
import { type TelegramMessageData } from '@/lib/inngest/client'
import { runIngest } from '@/lib/inngest/functions/ingest'
import { runCallback } from '@/lib/inngest/functions/callback'
import { deliverReminderNow } from '@/lib/inngest/functions/reminders'
import { CRON_JOBS, type CronJob } from '@/lib/inngest/functions/crons'
import { SCHEDULE, firingsOf } from '@/lib/inngest/schedule'
import { runShoppingRender, SHOPPING_DEBOUNCE_MS, SHOPPING_DEBOUNCE_TIMEOUT_MS, type RenderRequest } from '@/lib/lists/board'
import { runCategorize } from '@/lib/lists/categorize'
import { ensureRegistered } from '@/lib/memory/write'
import { upsertMember } from '@/lib/identity/roster'
import { and, asc, eq, gt, lte, ne, notInArray } from 'drizzle-orm'
import { houseConfig, reminders } from '@/db/schema'
import { withSimulatedTime } from '@/lib/core/clock'
import { captureOutbound, isCapturing, type OutboundMessage } from '@/lib/telegram/outbox'
import { SANDBOX_BOT_ID, SANDBOX_BOT_USERNAME } from '@/lib/telegram/client'
import { messageContent, type MediaKind } from '@/lib/telegram/content'

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
  /** In the Telegram group, but Baumy has never registered them (joined, never spoke, and Baumy is not
   *  an admin so no chat_member update came — K6). Not seeded into the roster; the sandbox's membership
   *  directory (getChatMember) still knows them. */
  unseen?: boolean
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
  /** When the debounced live-list render is due (5 seconds after the LAST list change, at most 30
   *  seconds after the first), or null. Production's Inngest debounce, played on the sandbox clock
   *  (noteShoppingChanged). */
  shoppingRepostAt?: Date | null
  /** The first change of the pending burst (the debounce's max-wait anchor), and the house it named. */
  shoppingBurstAt?: Date | null
  shoppingGroupId?: string | null
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
  // (postMessage, the digest, the surfacing scan) resolves to THIS house and not a real one.
  await input.db
    .insert(houseConfig)
    .values({ id: true, houseGroupChatId: houseChatId, houseTimezone: tz })
    .onConflictDoUpdate({ target: houseConfig.id, set: { houseGroupChatId: houseChatId, houseTimezone: tz } })
  for (const p of input.people) {
    if (p.unseen) continue
    await upsertMember(input.db, houseChatId, String(p.id), p.name, p.role ?? 'member')
  }
  return { db: input.db, houseChatId, now: new Date(input.startAt), tz, people: input.people, transcript: [], seq: 1, shoppingRepostAt: null, shoppingBurstAt: null }
}

// A `lists/shopping.changed` event was sent (the caller captures inngest.send): like Inngest's debounce,
// each change pushes the one pending render to SHOPPING_DEBOUNCE after it — but never past
// SHOPPING_DEBOUNCE_TIMEOUT after the first change of the burst. advanceTo runs it then.
export function noteShoppingChanged(sb: Sandbox, groupId: string = sb.houseChatId): void {
  sb.shoppingGroupId = groupId
  sb.shoppingBurstAt ??= new Date(sb.now)
  const quiet = sb.now.getTime() + SHOPPING_DEBOUNCE_MS
  const cap = sb.shoppingBurstAt.getTime() + SHOPPING_DEBOUNCE_TIMEOUT_MS
  sb.shoppingRepostAt = new Date(Math.min(quiet, cap))
}

// A `lists/shopping.render` event (a tap, /list, /shoppinghere): production's shopping-render runs it at
// once (no debounce), so the sandbox does too — inside the capture of whatever sent it, when there is one.
export async function renderShoppingNow(sb: Sandbox, req: RenderRequest): Promise<void> {
  if (isCapturing()) {
    await runShoppingRender(inlineStep, () => sb.db, req)
    return
  }
  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runShoppingRender(inlineStep, () => sb.db, req)))
  sb.transcript.push(...sent.map((m) => ({ ...m, cause: 'shopping-render' })))
}

// A `lists/shopping.categorize` event (issue #29): production's shopping-categorize runs it right after
// the add; the sandbox runs it at once too — inside the capture of whatever sent it, when there is one —
// so a scenario sees the item sorted (and its debounced re-render armed) in the same turn.
export async function categorizeShoppingNow(sb: Sandbox, data: { groupId: string; itemIds: string[] }): Promise<void> {
  if (isCapturing()) {
    await runCategorize(inlineStep, () => sb.db, data)
    return
  }
  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runCategorize(inlineStep, () => sb.db, data)))
  sb.transcript.push(...sent.map((m) => ({ ...m, cause: 'shopping-categorize' })))
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
  /** Reuse an earlier message's id — how Telegram delivers an EDIT (a new update, same message_id).
   *  Defaults to a fresh id. */
  messageId?: number
  /** This is an edited_message (I1): the webhook's isEdit flag. Use with `messageId`. */
  edit?: boolean
  /** The text is the CAPTION of this media (a photo, a document…) — mapped exactly as the webhook maps a
   *  real message (lib/telegram/content.ts), so the caption fold (I4) is what the pipeline receives. */
  media?: MediaKind
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
  const raw = opts.mention ? `@${SANDBOX_BOT_USERNAME} ${text}` : text
  const content = opts.media ? messageContent({ [opts.media]: {}, caption: raw }) : { text: raw, media: null }
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
      text: content.text,
      media: content.media,
      isEdit: opts.edit === true,
      messageThreadId: opts.dm ? null : (opts.threadId ?? null),
      isBot: anon,
      isForwarded: opts.forwarded ?? false,
      senderChatId: anon ? sb.houseChatId : null,
      ...replyFields(sb, opts),
    },
  }

  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runIngest(event, inlineStep)), {
    chatMembers: (chatId, userId) => groupMembership(sb, chatId, userId),
  })
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
  opts: { verb?: 'confirm' | 'cancel'; chatId?: string; messageId?: number; /** Raw callback_data (a live-list button), instead of a confirm card's. */ data?: string; /** What the tapped live-list button showed (the webhook reads it from the keyboard). */ want?: 'tick' | 'untick' | null } = {},
): Promise<TranscriptEntry[]> {
  const person = findPerson(sb, who)
  const updateId = sb.seq++
  const data = {
    callbackId: `cb${updateId}`,
    fromId: person.id,
    chatId: opts.chatId ?? sb.houseChatId,
    messageId: opts.messageId ?? updateId,
    data: opts.data ?? `${opts.verb === 'cancel' ? 'x' : 'c'}:${actionId}`,
    ...(opts.want !== undefined ? { want: opts.want } : {}),
  }
  const { sent } = await captureOutbound(async () => withSimulatedTime(sb.now, () => runCallback({ data }, inlineStep)))
  const entries = sent.map((m) => ({ ...m, cause: `${person.name}: tap ${opts.data ?? opts.verb ?? 'confirm'}` }))
  sb.transcript.push(...entries)
  return entries
}

// Telegram's view of the sandbox group (the getChatMember stand-in, K6): every sandbox person is in it,
// registered by Baumy or not; nobody else is.
function groupMembership(sb: Sandbox, chatId: string, userId: number): string | null {
  if (chatId !== sb.houseChatId) return null
  const p = sb.people.find((x) => x.id === userId)
  return p ? (p.role === 'owner' ? 'creator' : 'member') : null
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

// The scheduled work: production's cron table (lib/inngest/schedule.ts) played on a clock we control.
// Inngest's schedules cannot be advanced from app code, so the sandbox runs the SAME jobs production's
// cron functions run (CRON_JOBS — each owns its gates: no house, /pause, reminder_frequency) at every
// firing of the SAME cron. Entries the sandbox skips say why in the table. Ties at one instant run in
// table order.
const SANDBOX_JOBS = SCHEDULE.filter((e) => e.sandbox === true).map((e) => {
  const job: CronJob | undefined = (CRON_JOBS as Record<string, CronJob>)[e.id]
  if (!job) throw new Error(`[sandbox] schedule entry ${e.id} has sandbox: true but no one-step job in CRON_JOBS`)
  return { id: e.id, cron: e.cron, job }
})

// Every job firing strictly after `from` and at or before `to`, in chronological order.
function firingsBetween(from: Date, to: Date): { at: Date; id: string; job: CronJob }[] {
  const out = SANDBOX_JOBS.flatMap((j, order) => firingsOf(j.cron, from, to).map((at) => ({ at, id: j.id, job: j.job, order })))
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.order - b.order)
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
  // The debounced live-list render (docs/spec/shopping-list.md §Live list), at its own instant.
  const renderUntil = async (limit: Date) => {
    const at = sb.shoppingRepostAt
    if (!at || at.getTime() > limit.getTime()) return
    sb.shoppingRepostAt = null
    sb.shoppingBurstAt = null
    const { sent } = await captureOutbound(async () =>
      withSimulatedTime(at, () => runShoppingRender(inlineStep, () => sb.db, { groupId: sb.shoppingGroupId ?? sb.houseChatId, reason: 'change' })),
    )
    const said = sent.map((m) => ({ ...m, cause: 'debounce:shopping-changed' }))
    sb.transcript.push(...said)
    fired.push({ job: 'shopping-changed', at, said })
    sb.now = at
  }
  for (const { at, id, job } of firingsBetween(from, to)) {
    await deliverExplicitUntil(at)
    await renderUntil(at)
    const { sent } = await captureOutbound(async () => withSimulatedTime(at, () => job.run(sb.db, at, sb.tz, sb.houseChatId)))
    const said = sent.map((m) => ({ ...m, cause: `cron:${id}` }))
    sb.transcript.push(...said)
    fired.push({ job: id, at, said })
    sb.now = at
  }
  await deliverExplicitUntil(to)
  await renderUntil(to)
  sb.now = to
  return { from, to, fired }
}

/** Convenience: advance by a duration instead of to an absolute instant. */
export const advanceBy = (sb: Sandbox, opts: { days?: number; hours?: number; minutes?: number; seconds?: number }): Promise<AdvanceResult> =>
  advanceTo(sb, DateTime.fromJSDate(sb.now).plus(opts).toJSDate())

/** Just the lines Baumy actually posted to the group, for a readable assertion or a UI transcript. */
export const spoken = (entries: TranscriptEntry[]): string[] =>
  entries.filter((e) => e.kind === 'message' && e.text).map((e) => e.text as string)
