import { DateTime } from 'luxon'
import { createHttpDb } from '@/db/client'
import { inngest } from '@/lib/inngest/client'
import { extractListOp } from '@/lib/ai/list-extract'
import { extractReminder } from '@/lib/ai/reminder-extract'
import { extractForget } from '@/lib/ai/forget-extract'
import { addListItems, checkOffItems, currentList } from '@/lib/lists/store'
import { parseWhen, clampToWakingHours } from '@/lib/reminders/parse'
import { createReminder } from '@/lib/reminders/store'
import { saveReminderDraft } from '@/lib/reminders/draft'
import { findMemoryToForget, type ForgetMode } from '@/lib/memory/forget'
import { createPendingAction } from '@/lib/confirm/store'
import { memberDisplayNames } from '@/lib/identity/roster'
import { now } from '@/lib/core/clock'
import type { ForgetOutcome, ListOutcome, ReminderOutcome, TurnContext } from './context'
import type { TurnStep } from './step'

// The turn's ACTIONS (docs/spec/chat-understanding-v2.md §1 TurnOutcome). Each one is the LLM
// proposing (an extractor names the items / time / target) and deterministic code disposing (the
// store, the parser, the resolver), inside ONE memoized step so a retry never re-mutates. Each
// returns what ACTUALLY happened — the planner picks the voice from that and the reply model is
// told it (THIS TURN), so Baumy can no longer confirm a reminder that was never created (A3).

// ── Shopping list (docs/spec/shopping-list.md) ──────────────────────────────────────────────────
// AUTO-COMMIT, low-privilege (capture tier, NOT confirm-gated). Scope = the house (houseScope from
// the lane), attribution = the authenticated sender; quarantine + pause are gated upstream
// (listOpProposed). Undefined = the extractor found no list op after all (the classifier over-flagged).
export async function runList(step: TurnStep, ctx: TurnContext): Promise<ListOutcome | undefined> {
  // The MUTATION is ONE memoized step, and its RETURNING-derived result (added / already / checked-
  // off / not-found) is captured HERE — so a later fallible read can never recompute it against
  // already-mutated state and lie ("already there" / "couldn't find it"). The neon-http driver
  // autocommits per statement, so the write lands the instant it runs.
  type Mutation = { op: 'none' } | Omit<ListOutcome, 'open'>
  const mut = (await step.run('list', async (): Promise<Mutation> => {
    const db = createHttpDb()
    const ex = await extractListOp(ctx.text)
    if (ex.op === 'none') return { op: 'none' }
    if ((ex.op === 'add' || ex.op === 'checkoff') && ex.items.length === 0) return { op: 'none' }
    const base = { added: [], already: [], checkedOff: [], notFound: [] }
    if (ex.op === 'query') return { op: 'query', ...base }
    if (ex.op === 'add') {
      const res = await addListItems(db, { groupId: ctx.houseScope, items: ex.items, addedBy: ctx.authorId })
      return { op: 'add', ...base, added: res.added, already: res.already }
    }
    const res = await checkOffItems(db, { groupId: ctx.houseScope, items: ex.items, checkedBy: ctx.authorId })
    return { op: 'checkoff', ...base, checkedOff: res.checkedOff, notFound: res.notFound }
  })) as Mutation
  if (mut.op === 'none') return undefined
  // The open list after the op — an IDEMPOTENT read in its own step, so if it throws only this
  // re-runs and the memoized mutation above is never recomputed.
  const open = (await step.run('list-open', async () => (await currentList(createHttpDb(), ctx.houseScope)).map((r) => r.item))) as string[]
  return { ...mut, open }
}

// ── Reminders ────────────────────────────────────────────────────────────────────────────────────
// AUTO-COMMIT the ACTION (no click-to-confirm — a reminder only posts TEXT to the fixed house group).
// Only reached for a DIRECTED ask (decide() — A9). Every way it can fail is an explicit status the
// planner turns into a clarifying question (A2): no time given → needs_time, a time that can't be
// read → unparsed, a time already gone → past. The time-resolution overhaul is phase 3 (§6); this
// only makes the outcome honest. Undefined = the extractor says it isn't a reminder at all.
type ReminderStepResult =
  | { status: 'set'; fireAt: string; content: string }
  | { status: 'needs_time' | 'past' | 'unparsed'; content: string }
  | { status: 'none' }

// `draft` = an earlier request from this sender in this chat that is still waiting for its time
// (lib/reminders/draft.ts): "at 8pm" in reply to "when should I remind you?" completes it — the
// extractor is shown the open request and Baumy's question. Every failure (needs_time / unparsed /
// past) stores a fresh draft, so the clarifying question Baumy asks can actually be answered.
export async function runReminder(
  step: TurnStep,
  ctx: TurnContext,
  deliverChatId: string,
  draft: { content: string } | null = null,
): Promise<ReminderOutcome | undefined> {
  const r = (await step.run('reminder', async (): Promise<ReminderStepResult> => {
    const db = createHttpDb()
    const speaker = ctx.authorId ? ((await memberDisplayNames(db)).get(ctx.authorId) ?? ctx.sender.name) : null
    const baumyAsked = ctx.replyTo?.author === 'baumy' ? ctx.replyTo.text : null
    const ex = await extractReminder(ctx.text, speaker, draft ? { pending: draft.content, baumyAsked } : null)
    // A follow-up that only supplies the time ("8pm") completes the open request's content.
    const content = ex.content.trim() || draft?.content.trim() || ''
    const isReminder = ex.isReminder || (draft != null && ex.whenText.trim() !== '')
    if (!isReminder || !content) return { status: 'none' } // empty content would post a bare "⏰"
    // Remember the open request (scope = house, keyed on chat + requester) so the answer to the
    // clarifying question can complete it. An anonymous admin has no requester to key it on.
    const failed = async (status: 'needs_time' | 'past' | 'unparsed'): Promise<ReminderStepResult> => {
      if (ctx.authorId) await saveReminderDraft(db, { groupId: ctx.houseScope, chatId: ctx.chatId, requestedBy: ctx.authorId }, content)
      return { status, content }
    }
    if (!ex.whenText.trim()) return failed('needs_time')
    const at = DateTime.fromJSDate(now())
    const parsed = parseWhen(ex.whenText, ctx.tz, at) // resolve "9am" in the house timezone
    if (!parsed) return failed('unparsed')
    if (parsed.fireAt.getTime() <= at.toMillis()) return failed('past')
    // Fire near the requested time, but never in the 02:00–06:00 dead zone (no 3am pings).
    const fireAt = clampToWakingHours(parsed.fireAt, ctx.tz)
    const id = await createReminder(db, {
      groupId: ctx.houseScope, // scope = the house (a DM-set reminder belongs to the house, not a silo)
      deliverChatId, // fixed destination, resolved in code (never LLM)
      content,
      fireAt,
      createdBy: ctx.authorId,
    })
    // Best-effort arm; the sweeper backstops delivery, so a hand-off failure here never retries
    // the step into a duplicate reminder.
    try {
      await inngest.send({ id: `reminder-arm:${id}`, name: 'reminder/arm.due', data: { reminderId: id } })
    } catch {
      /* sweeper still delivers */
    }
    return { status: 'set', fireAt: fireAt.toISOString(), content }
  })) as ReminderStepResult
  if (r.status === 'none') return undefined
  // Step results are JSON-memoized — rehydrate the Date.
  return r.status === 'set' ? { status: 'set', fireAt: new Date(r.fireAt), content: r.content, deliverTo: 'house' } : r
}

// ── Forget (deletion on request) ─────────────────────────────────────────────────────────────────
// PROPOSE a deletion only: the LLM describes what to forget, this code resolves it to concrete,
// group-scoped rows and stores a pending action. Nothing is deleted until a member taps confirm
// (functions/callback.ts, the confirm-tap wall). Memoized, so a retry never creates a second card.
export async function runForget(step: TurnStep, ctx: TurnContext): Promise<ForgetOutcome> {
  return (await step.run('forget', async (): Promise<ForgetOutcome> => {
    const db = createHttpDb()
    const speaker = ctx.authorId ? ((await memberDisplayNames(db)).get(ctx.authorId) ?? null) : null
    const ex = await extractForget(ctx.text, speaker)
    if (!ex.isForget) return { proposed: false, reason: 'not_forget' }
    const matches = await findMemoryToForget(db, ctx.houseScope, { values: ex.values, subject: ex.subject, attribute: ex.attribute })
    const mode: ForgetMode = ex.permanent ? 'purge' : 'soft'
    const aliasCount = matches.aliasHits.reduce((n, h) => n + h.remove.length, 0)
    const hasFacts = matches.facts.length > 0
    const hasScrub = matches.noteIds.length > 0 || aliasCount > 0
    // soft can only HIDE facts; purge also scrubs messages + aliases. If this mode can't act on
    // what we found, say why (or ask) rather than a misleading proposal.
    if (!hasFacts && !(mode === 'purge' && hasScrub)) {
      if (mode === 'soft' && hasScrub) return { proposed: false, reason: 'notes_only' }
      if (ex.values.length === 0 && !ex.subject) return { proposed: false, reason: 'vague' }
      return { proposed: false, reason: 'nothing' }
    }
    const pendingId = await createPendingAction(db, {
      groupId: ctx.houseScope, // the house being modified (scope), not the DM chat
      actionType: 'memory.forget',
      payload: {
        mode,
        factIds: matches.factIds,
        scrubValues: matches.scrubValues,
        noteIds: matches.noteIds,
        aliasHits: matches.aliasHits,
        summary: ex.values.join(', ') || [ex.subject, ex.attribute].filter(Boolean).join(' ') || 'that',
      },
      requestedBy: ctx.authorId,
    })
    const lines: string[] = matches.facts.map((c) => `• ${c.label}`)
    if (mode === 'purge') {
      if (matches.noteIds.length && matches.scrubValues.length) {
        lines.push(
          `• scrub ${matches.scrubValues.map((v) => `"${v}"`).join(', ')} out of ${matches.noteIds.length} message${matches.noteIds.length === 1 ? '' : 's'} (keeping the rest)`,
        )
      }
      if (aliasCount) lines.push(`• drop ${aliasCount} alias${aliasCount === 1 ? '' : 'es'}`)
    }
    const head = mode === 'purge' ? "I'll permanently forget (no undo):" : "I'll forget (hidden, reversible):"
    return { proposed: true, pendingId, card: `${head}\n${lines.join('\n')}\n\nTap to confirm.` }
  })) as ForgetOutcome
}

/** The deterministic line for a forget request that has nothing to confirm. */
export function forgetExplanation(reason: Exclude<Extract<ForgetOutcome, { proposed: false }>['reason'], 'not_forget'>): string {
  if (reason === 'notes_only') return `That's only in past messages, not a fact I can just hide — say "permanently forget it" and I'll scrub it out for good. 😼`
  if (reason === 'vague') return `What exactly should I forget? Name the specific thing — a name, number, that kind of thing 😼`
  return `Nothing like that in my memory, so nothing to forget 😼`
}
