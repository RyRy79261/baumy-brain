import { DateTime } from 'luxon'
import { createHttpDb } from '@/db/client'
import { inngest } from '@/lib/inngest/client'
import { extractListOp } from '@/lib/ai/list-extract'
import { extractReminder, type ExtractedReminder } from '@/lib/ai/reminder-extract'
import { extractForget } from '@/lib/ai/forget-extract'
import { addListItems, checkOffItems, currentList } from '@/lib/lists/store'
import { clampToWakingHours } from '@/lib/reminders/parse'
import { fireAtFromModel, reminderTimeFromPhrase, minutesApart } from '@/lib/core/when'
import { normaliseRecurrence, recurrenceFromPhrase, nextOccurrence } from '@/lib/reminders/recurrence'
import { createReminder } from '@/lib/reminders/store'
import { saveReminderDraft } from '@/lib/reminders/draft'
import { findMemoryToForget, type ForgetMode } from '@/lib/memory/forget'
import { createPendingAction } from '@/lib/confirm/store'
import { memberDisplayNames } from '@/lib/identity/roster'
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
// Only reached for a DIRECTED ask (decide() — A9). The extractor PROPOSES one or more reminders (A6),
// each with a fireAt it resolved against the calendar table, a repeat rule and who it is for; this code
// DISPOSES (spec §6): every way one can fail is an explicit status the planner turns into a clarifying
// question (A2) — no time given → needs_time, a time that can't be read → unparsed, a time already gone
// → past. Undefined = the extractor says it isn't a reminder at all.
type OneReminder =
  | { status: 'set'; id: string; fireAt: string; content: string; recurrence: string | null }
  | { status: 'needs_time' | 'past' | 'unparsed'; content: string }

// `draft` = an earlier request from this sender in this chat that is still waiting for its time
// (lib/reminders/draft.ts): "at 8pm" in reply to "when should I remind you?" completes it — the
// extractor is shown the open request and Baumy's question. A failure (needs_time / unparsed / past)
// stores a fresh draft, so the clarifying question Baumy asks can actually be answered.
export async function runReminder(
  step: TurnStep,
  ctx: TurnContext,
  deliverChatId: string,
  draft: { content: string } | null = null,
): Promise<ReminderOutcome[] | undefined> {
  const results = (await step.run('reminder', async (): Promise<OneReminder[]> => {
    const db = createHttpDb()
    const speaker = ctx.authorId ? ((await memberDisplayNames(db)).get(ctx.authorId) ?? ctx.sender.name) : null
    const baumyAsked = ctx.replyTo?.author === 'baumy' ? ctx.replyTo.text : null
    const ex = await extractReminder(ctx.text, speaker, draft ? { pending: draft.content, baumyAsked } : null, { at: ctx.sentAt, tz: ctx.tz })
    const out: OneReminder[] = []
    let draftSaved = false
    for (const r of ex.reminders) {
      // A follow-up that only supplies the time ("8pm") completes the open request's content.
      const content = r.content.trim() || draft?.content.trim() || ''
      if (!content) continue // empty content would post a bare "⏰"
      const resolved = resolveReminderTime(r, ctx)
      if (resolved.status !== 'ok') {
        // Remember the open request (scope = house, keyed on chat + requester) so the answer to the
        // clarifying question can complete it. One draft per turn; an anonymous admin has no requester.
        if (ctx.authorId && !draftSaved) {
          await saveReminderDraft(db, { groupId: ctx.houseScope, chatId: ctx.chatId, requestedBy: ctx.authorId }, content)
          draftSaved = true
        }
        out.push({ status: resolved.status, content })
        continue
      }
      // A personal reminder names who asked (A4): "⏰ Charli: call the plumber", never a nameless line
      // three housemates each assume is someone else's job. The name is the AUTHENTICATED sender's.
      const forSpeaker = r.forWhom ? r.forWhom === 'speaker' : /\bremind me\b/i.test(ctx.text)
      const named = forSpeaker && ctx.authorId ? nameRequester(content, ctx.sender.firstName) : content
      const id = await createReminder(db, {
        groupId: ctx.houseScope, // scope = the house (a DM-set reminder belongs to the house, not a silo)
        deliverChatId, // fixed destination, resolved in code (never LLM)
        content: named,
        fireAt: resolved.fireAt,
        createdBy: ctx.authorId,
        recurrence: resolved.recurrence,
      })
      // Best-effort arm; the sweeper backstops delivery, so a hand-off failure here never retries
      // the step into a duplicate reminder.
      try {
        await inngest.send({ id: `reminder-arm:${id}`, name: 'reminder/arm.due', data: { reminderId: id } })
      } catch {
        /* sweeper still delivers */
      }
      out.push({ status: 'set', id, fireAt: resolved.fireAt.toISOString(), content: named, recurrence: resolved.recurrence })
    }
    return out
  })) as OneReminder[]
  if (results.length === 0) return undefined
  // Step results are JSON-memoized — rehydrate the Date.
  return results.map((r) =>
    r.status === 'set'
      ? { status: 'set', id: r.id, fireAt: new Date(r.fireAt), content: r.content, deliverTo: 'house', ...(r.recurrence ? { recurrence: r.recurrence } : {}) }
      : r,
  )
}

/** The outcome the planner reads when a message produced several: the first failure (it needs the
 *  clarifying question), else the first reminder set. THIS TURN still lists every one. */
export function primaryReminder(all: ReminderOutcome[]): ReminderOutcome {
  return all.find((r) => r.status !== 'set') ?? all[0]
}

type Resolved = { status: 'ok'; fireAt: Date; recurrence: string | null } | { status: 'needs_time' | 'past' | 'unparsed' }

// The time a proposed reminder fires, DISPOSED by code (spec §6):
//   • the model's fireAt (local ISO against the calendar table) when it parses and is < 2 years out;
//   • else chrono on the verbatim phrase with the fixed defaults (lib/core/when.ts) — the fallback;
//   • both present and >1 min apart → the model's wins (it saw the calendar), the disagreement is
//     logged, and the confirm line shows the resolved day + time so a misread is visible (§3);
//   • nothing at all → needs_time; something unreadable → unparsed;
//   • already past → a recurring reminder moves to its next occurrence; a one-off whose time of day
//     was only a default (a bare "today", "tonight" at 23:30) asks for a time (needs_time); any other
//     past time (a lead time that already went — "a week before friday" on Wednesday) → past. A past
//     row is never created: it would be delivered instantly (T4/T10).
//   • never the 02:00–06:00 dead zone.
function resolveReminderTime(r: ExtractedReminder, ctx: TurnContext): Resolved {
  const at = ctx.sentAt
  const tz = ctx.tz
  const fromModel = fireAtFromModel(r.fireAt, tz, at)
  const fromPhrase = reminderTimeFromPhrase(r.whenText, tz, at)
  if (fromModel && fromPhrase && minutesApart(fromModel, fromPhrase.fireAt) > 1)
    console.warn(`[baumy/reminder] time cross-check: model ${r.fireAt} vs "${r.whenText}" → ${fromPhrase.fireAt.toISOString()} (keeping the model's)`)
  let fireAt = fromModel ?? fromPhrase?.fireAt ?? null
  if (!fireAt) return { status: r.fireAt?.trim() || r.whenText?.trim() ? 'unparsed' : 'needs_time' }
  const timeDefaulted = fromModel ? !/T\d/.test(r.fireAt ?? '') : fromPhrase!.timeDefaulted
  const recurrence = normaliseRecurrence(r.recurrence?.trim() || recurrenceFromPhrase(r.whenText), fireAt, tz)
  if (fireAt.getTime() <= at.getTime()) {
    const sameDay = DateTime.fromJSDate(fireAt).setZone(tz).hasSame(DateTime.fromJSDate(at).setZone(tz), 'day')
    if (recurrence) fireAt = nextOccurrence(recurrence, fireAt, at, tz)
    else return { status: timeDefaulted && sameDay ? 'needs_time' : 'past' }
    if (!fireAt) return { status: 'unparsed' }
  }
  return { status: 'ok', fireAt: clampToWakingHours(fireAt, tz), recurrence }
}

/** "Charli: call the plumber" — unless the content already opens with their name. */
export function nameRequester(content: string, firstName: string | null | undefined): string {
  const name = firstName?.trim()
  if (!name) return content
  const opens = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  return opens.test(content.trim()) ? content : `${name}: ${content}`
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
