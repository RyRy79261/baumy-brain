import { DateTime } from 'luxon'
import type { Trust } from '@/lib/core/origin'
import type { DirectedWhy } from '@/lib/pipeline/directed'
import type { ClassifierVerdict } from '@/lib/ai/classify'
import { scanSensitivity } from '@/lib/core/sensitivity'

// The TURN (docs/spec/chat-understanding-v2.md §1): one inbound message and everything the system
// KNOWS about it — who is speaking, where, why it is for Baumy, what it is replying to — built
// deterministically by ingest BEFORE any LLM call, then enriched as steps run (the verdict, and in
// `outcome` what capture / the list / the reminder / forget actually did).
//
// Every field comes from Telegram-authenticated transport data or from our own code, never from
// message text. The reply model reads it as the CONTEXT block ("verified by the system, not by the
// message"), the planner decides the voice from it, and nothing in it grants privilege.

/** One recent chat line (phase 2 — the conversation window; always empty until then). */
export interface WindowTurn {
  at: Date
  author: string
  text: string
}

/** A fact as the reply model is told about it: never the secret value itself. */
export interface FactSummary {
  subject: string
  predicate: string
  object: string
  /** The time phrase / resolved event day, when the fact is about something happening. */
  when: string | null
  /** The object is a secret (stored encrypted) — rendered as a descriptor, never the value. */
  secure: boolean
}

export interface ListOutcome {
  op: 'add' | 'checkoff' | 'query'
  added: string[]
  already: string[]
  checkedOff: string[]
  notFound: string[]
  /** The open list after the op (a query renders it; a compound question may quote it). */
  open: string[]
}

export type ReminderOutcome =
  | { status: 'set'; fireAt: Date; content: string; recurrence?: string; deliverTo: 'house' | 'dm' }
  | { status: 'needs_time' | 'past' | 'unparsed'; content: string }

// What the forget flow did. `proposed` = a confirm card is ready (nothing is deleted until a tap);
// otherwise `reason` says why there is nothing to confirm. 'not_forget' means the extractor read the
// message as something else — the planner then treats it as an ordinary question.
export type ForgetOutcome =
  | { proposed: true; pendingId: string; card: string }
  | { proposed: false; reason: 'not_forget' | 'notes_only' | 'vague' | 'nothing' }

export interface TurnOutcome {
  captured?: { memoryItemId: string; factIds: string[]; learned: FactSummary[]; rejected: FactSummary[] }
  reminder?: ReminderOutcome
  list?: ListOutcome
  forget?: ForgetOutcome
}

export interface TurnSender {
  id: number
  /** Display name ("Charli Weber"); 'an admin' for an anonymous-admin post. */
  name: string
  firstName: string
  role: 'owner' | 'member'
}

export interface TurnContext {
  updateId: number
  messageId: number
  /** The reply DESTINATION (the inbound chat) — the house group or the sender's own DM. */
  chatId: string
  /** The memory SCOPE (houseScopeForOrigin) — distinct from the destination. */
  houseScope: string
  lane: 'house' | 'member_dm'
  sender: TurnSender
  /** Member id the words are attributed to — null for quarantined content or an anonymous admin. */
  authorId: string | null
  trust: Trust
  /** Message time (now() at ingest) and the house timezone it is read in. */
  sentAt: Date
  tz: string
  topic: { threadId: number | null; isConsole: boolean }
  directed: { value: boolean; why: DirectedWhy | null }
  replyTo: { author: 'baumy' | string; text: string | null } | null
  /** Normalised text: the @botname stripped (C12). */
  text: string
  recent: WindowTurn[]
  verdict?: ClassifierVerdict
  outcome: TurnOutcome
}

export interface TurnInput {
  updateId: number
  messageId: number
  chatId: string
  houseScope: string
  lane: 'house' | 'member_dm'
  fromId: number | null
  senderName: string | null
  isOwner: boolean
  anonymous: boolean
  authorId: string | null
  trust: Trust
  sentAt: Date
  tz: string
  threadId: number | null
  isConsole: boolean
  directed: { value: boolean; why: DirectedWhy | null }
  replyTo: { author: 'baumy' | string; text: string | null } | null
  text: string
}

// Pure: transport facts in, TurnContext out. No I/O, no LLM — so it is trivially testable and can
// never be steered by the message.
export function buildTurnContext(i: TurnInput): TurnContext {
  const given = i.anonymous ? '' : (i.senderName?.trim() ?? '')
  const name = i.anonymous ? 'an admin (posting anonymously)' : given || 'a housemate'
  return {
    updateId: i.updateId,
    messageId: i.messageId,
    chatId: i.chatId,
    houseScope: i.houseScope,
    lane: i.lane,
    sender: { id: i.fromId ?? 0, name, firstName: given ? given.split(/\s+/)[0] : name, role: i.isOwner ? 'owner' : 'member' },
    authorId: i.authorId,
    trust: i.trust,
    sentAt: i.sentAt,
    tz: i.tz,
    topic: { threadId: i.threadId, isConsole: i.isConsole },
    directed: i.directed,
    replyTo: i.replyTo,
    text: i.text,
    recent: [],
    outcome: {},
  }
}

/** Where the message was said, as the models are told it. */
export function describeWhere(ctx: Pick<TurnContext, 'lane' | 'topic'>): string {
  if (ctx.lane === 'member_dm') return 'private DM with you (only they see your reply)'
  if (ctx.topic.isConsole) return 'house group, ask-Baumy topic'
  return ctx.topic.threadId != null ? 'house group, a topic thread' : 'house group'
}

// A fact triple as the reply model may see it: a secure object is replaced by a descriptor, so a
// secret typed into THIS message can never be echoed back into the group by the ack.
export function summarizeFact(f: { subject: string; predicate: string; object: string }, when: string | null): FactSummary {
  const secure = scanSensitivity(`${f.subject} ${f.predicate} ${f.object}`).isSecure
  return { subject: f.subject, predicate: f.predicate.replace(/_/g, ' '), object: secure ? '(secret — stored encrypted)' : f.object, when, secure }
}

const fmtDay = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat('ccc d LLL')
const fmtWhen = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toFormat('ccc d LLL HH:mm')

// THIS TURN — what the system actually did with this message, one clause per action. The reply
// model may only claim an action this says happened (A3); an empty turn says so explicitly.
export function describeOutcome(o: TurnOutcome, tz: string): string {
  const parts: string[] = []
  const fact = (f: FactSummary) => `${f.subject} · ${f.predicate} · ${f.object}${f.when ? ` (${f.when})` : ''}`
  if (o.captured?.learned.length) parts.push(`noted — ${o.captured.learned.map(fact).join('; ')}`)
  else if (o.captured) parts.push('filed the message in memory (nothing new to add as a fact — possibly already known)')
  if (o.captured?.rejected.length) parts.push(`NOT stored (conflicts with something more trusted) — ${o.captured.rejected.map(fact).join('; ')}`)
  const r = o.reminder
  if (r?.status === 'set') parts.push(`reminder set ${fmtWhen(r.fireAt, tz)} — ${r.content}`)
  else if (r?.status === 'needs_time') parts.push(`no reminder was created — it needs a time (about: ${r.content})`)
  else if (r?.status === 'past') parts.push(`no reminder was created — that time is already past (about: ${r.content})`)
  else if (r?.status === 'unparsed') parts.push(`no reminder was created — couldn't work out when (about: ${r.content})`)
  const l = o.list
  if (l) {
    if (l.added.length) parts.push(`added to the shopping list: ${l.added.join(', ')}`)
    if (l.already.length) parts.push(`already on the shopping list: ${l.already.join(', ')}`)
    if (l.checkedOff.length) parts.push(`ticked off the shopping list: ${l.checkedOff.join(', ')}`)
    if (l.notFound.length) parts.push(`NOT on the shopping list (nothing ticked): ${l.notFound.join(', ')}`)
    if (l.op === 'query' || l.notFound.length) parts.push(`shopping list now: ${l.open.length ? l.open.join(', ') : '(empty)'}`)
  }
  if (o.forget?.proposed) parts.push('a forget request is waiting for a confirm tap (nothing deleted yet)')
  return parts.length ? parts.join('; ') : 'nothing was stored, scheduled or changed'
}

export { fmtDay, fmtWhen }
