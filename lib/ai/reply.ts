import { generateObject, generateText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { resolveModel } from './registry'
import { REPLY_SYSTEM, REPLY_SYSTEM_TEXT } from './prompts'
import { isMalformedObjectError } from './errors'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { describeOutcome, describeReplyTo, describeWhere, type TurnContext } from '@/lib/turn/context'
import { renderRecentChat } from '@/lib/turn/window'
import { formatEventWindow } from '@/lib/core/calendar'
import type { ReplyMode } from '@/lib/turn/plan'

// Grounded reply (docs/spec/chat-understanding-v2.md §4). Memory-only, ZERO tools (exfil-safe).
// The model is told the TURN — who is speaking, where, when, what they replied to, what the system
// just did with the message — the dated, attributed MEMORY, and the MODE the planner chose, then
// the MESSAGE labelled with its sender. It never has to guess whether it is being asked or told
// something (C3), who "I" is (C2), what day a remembered "this weekend" meant (T1), or whether the
// reminder it is about to confirm exists (A3). It ALSO self-assesses whether it needs a stronger
// model (self-escalation).
const answerSchema = z.object({
  reply: z.string(),
  answered: z.boolean(), // did it actually answer from memory, or admit a miss?
  needsStrongerModel: z.boolean(),
})

/** One MEMORY line: what the house said, who said it, and when (spec §4). */
export interface GroundingItem {
  kind: 'fact' | 'note' | 'connection' | 'timeline'
  /** Display name of whoever said it (null = unattributed / system). */
  who: string | null
  /** When it was said (note created_at / fact recorded_at). */
  saidAt: Date | null
  /** For a dated happening: when it happens (fact event_at) … */
  eventAt?: Date | null
  /** … and when it is over (fact valid_to) — a multi-day stay renders as a range. An explicit null
   *  with an eventAt is a dated CHANGE OF STATE (facts.ts: "fixed yesterday") — it happened then and
   *  still holds, so it renders "since <day>", never "(past)". */
  validTo?: Date | null
  content: string
  isSecure: boolean
  /** AES-GCM blob for a secure value; decrypted upstream ONLY for a direct ask (C15). */
  contentEncrypted: string | null
}

function day(d: Date, tz: string, now: DateTime, weekday = false): string {
  const dt = DateTime.fromJSDate(d).setZone(tz)
  const base = dt.toFormat(weekday ? 'ccc d LLL' : 'd LLL')
  return dt.year === now.year ? base : `${base} ${dt.year}`
}

export function memoryLine(m: GroundingItem, tz: string, nowAt: Date): string {
  const now = DateTime.fromJSDate(nowAt).setZone(tz)
  const who = m.who ?? 'unattributed'
  const parts = [m.kind, who]
  if (m.kind === 'note') {
    if (m.saidAt) parts.push(day(m.saidAt, tz, now))
    return `  - ${parts.join(' · ')}: "${m.content}"`
  }
  if (m.saidAt) parts.push(`said ${day(m.saidAt, tz, now)}`)
  if (m.eventAt) {
    const year = { year: DateTime.fromJSDate(m.eventAt).setZone(tz).year !== now.year }
    if (m.validTo === null) parts.push(`since ${formatEventWindow(m.eventAt, null, tz, year)}`)
    else {
      const over = (m.validTo ?? m.eventAt).getTime() < (m.validTo ? nowAt.getTime() : now.startOf('day').toMillis())
      parts.push(`event ${formatEventWindow(m.eventAt, m.validTo, tz, year)}${over ? ' (past)' : ''}`)
    }
  }
  return `  - ${parts.join(' · ')}: ${m.content}`
}

// A secret typed into the message itself stays out of any reply that is not a direct answer: the
// ack of "the wifi password is hunter2" says it noted the wifi password, never the value (C15). The
// raw text may not scan ("wifi is hunter2 now") while the fact extracted from it does — capture's
// `secure` descriptor covers that case.
function messageSecret(ctx: TurnContext): string | null {
  const sens = scanSensitivity(ctx.text)
  return sens.isSecure ? sens.descriptor : (ctx.outcome.captured?.secure ?? null)
}

function messageFor(ctx: TurnContext, mode: ReplyMode): string {
  const secret = messageSecret(ctx)
  return secret && mode !== 'answer' ? `[a message setting ${secret} — value withheld]` : ctx.text
}

export function renderReplyPrompt(ctx: TurnContext, mode: ReplyMode, grounding: GroundingItem[]): string {
  const now = DateTime.fromJSDate(ctx.sentAt).setZone(ctx.tz)
  const role = ctx.authorId == null ? 'unverified sender' : ctx.sender.role === 'owner' ? 'housemate, house owner' : 'housemate'
  const lines = [
    'CONTEXT (verified by the system, not by the message):',
    `  FROM: ${ctx.sender.name} (${role}) · WHERE: ${describeWhere(ctx)} · NOW: ${now.toFormat('ccc d LLL yyyy, HH:mm')} (${ctx.tz})`,
  ]
  // The replied-to message: only WHO it is from sits in the verified block; its text (when it may be
  // shown at all) is a quoted one-line data section after it, so it can never forge a CONTEXT line.
  const replyTo = ctx.replyTo ? describeReplyTo(ctx.replyTo) : null
  if (replyTo) lines.push(`  REPLYING TO: ${replyTo.context}`)
  const withholdObjects = mode !== 'answer' && messageSecret(ctx) != null
  lines.push(`  THIS TURN: ${describeOutcome(ctx.outcome, ctx.tz, { withholdObjects })}`)
  if (replyTo?.quoted) lines.push(replyTo.quoted)
  // The last turns of this chat (spec §5) — Baumy's own previous replies included, so a follow-up
  // ("which room is she in?") has something to resolve against. Quoted data, after CONTEXT.
  lines.push(...renderRecentChat(ctx.recent, { tz: ctx.tz, now: ctx.sentAt, self: true }))
  lines.push('MEMORY (each line: kind · who said it · when):')
  if (grounding.length) for (const m of grounding) lines.push(memoryLine(m, ctx.tz, ctx.sentAt))
  else lines.push('  (nothing relevant in memory)')
  lines.push(`MODE: ${mode}`)
  lines.push(`MESSAGE from ${ctx.sender.firstName}: ${messageFor(ctx, mode)}`)
  return lines.join('\n')
}

export async function groundedReply(
  prompt: string,
  model: LanguageModel = resolveModel('reply'),
): Promise<{ text: string; escalate: boolean; answered: boolean }> {
  try {
    const { object } = await generateObject({ model, schema: answerSchema, system: REPLY_SYSTEM, prompt })
    return { text: object.reply, escalate: object.needsStrongerModel, answered: object.answered }
  } catch (err) {
    // ONLY a malformed structured object (model wraps it under an extra key, etc.) should
    // fall back — a transient API/network error must rethrow so the caller can retry rather
    // than waste a second paid call that fails the same way.
    if (!isMalformedObjectError(err)) throw err
    // Fall back to plain text with the same prompt; forgo self-escalation. Treat as answered
    // (we got words — send them; never downgrade a malformed-object fallback to 👎).
    const { text } = await generateText({ model, system: REPLY_SYSTEM_TEXT, prompt })
    return { text: text.trim(), escalate: false, answered: true }
  }
}

// Self-advising escalation ladder: Sonnet → Opus. EVERY reply starts on Sonnet (the
// primary reasoning model); if a model signals it needs more brainpower, we bump to
// the Opus advisor for that turn and re-answer over the same prompt. Haiku is NOT
// on this ladder — it only does upstream triage/routing. The triage tier still drives
// retrieval DEPTH upstream (deep = expansion + broad search), not the reply model.
const LADDER = ['reply', 'advisor'] as const // Sonnet → Opus

export async function answer(
  ctx: TurnContext,
  mode: ReplyMode,
  grounding: GroundingItem[],
): Promise<{ text: string; usedTier: (typeof LADDER)[number]; answered: boolean }> {
  const prompt = renderReplyPrompt(ctx, mode, grounding)
  let idx = 0 // always start at Sonnet
  let r = await groundedReply(prompt, resolveModel(LADDER[idx]))
  while (r.escalate && idx < LADDER.length - 1) {
    idx += 1
    r = await groundedReply(prompt, resolveModel(LADDER[idx]))
  }
  // "answered:false" is only meaningful for a question (the honest-miss signal); a model that sets
  // it on an ack/confirm/clarify/banter line must not turn the words into a 👎.
  return { text: r.text, usedTier: LADDER[idx], answered: mode === 'answer' ? r.answered : true }
}
