import { createHttpDb } from '@/db/client'
import type { ChatDestination, Origin } from '@/lib/core/origin'
import type { ResponsePolicy } from '@/lib/policy'
import { takeReminderDraft } from '@/lib/reminders/draft'
import { runCapture } from './capture'
import { runList, runReminder, runForget, runCancelReminder, runOlympics, primaryReminder } from './actions'
import { withdrawForEdit, settleEditedFacts, type EditMap } from './edit'
import { linkProduced, withholdTurn } from './window'
import { planResponse, type Plan } from './plan'
import { executePlan } from './respond'
import { turnGates, type TurnGates } from './gates'
import type { TurnContext } from './context'
import type { TurnStep } from './step'

// The TURN RUNNER (docs/spec/chat-understanding-v2.md §1): everything after triage, in ONE place —
// which actions run (lib/turn/gates.ts), in what ORDER, what each actually did (ctx.outcome), the
// edit's withdraw/settle, the window's withholds and produced-map, and then ONE planResponse(ctx) and
// its execution. ingest.ts is intake and triage; it hands the classified TurnContext here.
//
// Order is part of the contract:
//   edit-withdraw → list → Olympics → reminders (+ a pending draft) → capture → edit-settle
//   → forget proposal → reminder-cancel proposal → window-link → plan → execute
// The list op runs first because a message handled as one is NOT also captured (A11); reminders run
// before capture because a private DM reminder is not captured (D2); the edit's withdraw runs before
// anything re-reads the edited text.

export interface TurnEnv {
  origin: Origin
  policy: ResponsePolicy
  /** The original's produced-map when this message is an EDIT (lib/turn/edit.ts); null otherwise. */
  editMap: EditMap | null
  /** The house's stable scope id — a house reminder's group (runReminder). */
  houseChatId: string
  /** addressingFor: may the window hold this message? */
  windowable: boolean
  /** addressingFor: where words may go (null = nowhere). */
  reply: ChatDestination | null
}

export interface TurnResult {
  gates: TurnGates
  plan: Plan
}

export async function runTurn(step: TurnStep, ctx: TurnContext, env: TurnEnv): Promise<TurnResult> {
  const verdict = ctx.verdict
  if (!verdict) throw new Error('[baumy/turn] runTurn needs a classified TurnContext')
  const { origin, policy, editMap, windowable } = env
  const scope = ctx.houseScope
  const at = { chatId: ctx.chatId, messageId: ctx.messageId }
  const gates = turnGates({
    origin,
    verdict,
    directed: ctx.directed.value,
    authorId: ctx.authorId,
    scope,
    windowable,
    enabled: policy.global_enabled,
    isEdit: ctx.edit != null,
    text: ctx.text,
  })

  if (gates.withholdForget) {
    await step.run('window-withhold', () => withholdTurn(createHttpDb(), at, '[asked Baumy to forget something — withheld]'))
  }

  // An edit of a processed message: withdraw what the original produced BEFORE the edited text is
  // re-read — its note (so consolidation cannot fold the edit back onto it) and its unsent reminders
  // (the edit re-creates whatever it still asks for). Facts are settled after capture. While PAUSED the
  // original's reminders are kept: the edit cannot re-create them, and nobody would be told.
  if (editMap?.processed) {
    await step.run('edit-withdraw', () =>
      withdrawForEdit(createHttpDb(), scope, gates.keepRemindersForEdit ? { ...editMap, reminderIds: [] } : editMap),
    )
  }

  // The shopping list first: a list op is not also captured as a note (A11) — "we're out of milk"
  // lives in the list table, where "got the milk" ticks it off.
  if (gates.list) ctx.outcome.list = await runList(step, ctx)

  // Baumy Olympics, AS the sender: reads answer straight away, a write is a confirm card until the asker
  // taps it. Like a list op it lives in Olympics, not as a memory note.
  if (gates.olympics) ctx.outcome.olympics = await runOlympics(step, ctx)

  // Reminders (+ a draft still waiting for its time, taken one-shot — the answer to Baumy's clarifying
  // question). A paused ask is an explicit outcome, so a DM ask hears WHY nothing was scheduled.
  const draft =
    gates.reminderDraft && ctx.authorId
      ? ((await step.run('reminder-draft', () => takeReminderDraft(createHttpDb(), { groupId: scope, chatId: ctx.chatId, requestedBy: ctx.authorId! }))) as {
          content: string
        } | null)
      : null
  if (gates.reminder === 'ask' || draft) {
    const all = await runReminder(step, ctx, env.houseChatId, draft)
    if (all) {
      ctx.outcome.reminders = all
      ctx.outcome.reminder = primaryReminder(all)
    }
  } else if (gates.reminder === 'paused') {
    ctx.outcome.reminder = { status: 'paused' }
  }

  // A reminder asked for in a member's own DM is PRIVATE (D2): delivered to that DM, never listed in
  // the group — so its words are not written into shared house memory either. Only when the reminder
  // step set one for the HOUSE is the message house business.
  const privateDmReminder =
    ctx.lane === 'member_dm' &&
    (gates.decision === 'reminder' || verdict.intent === 'reminder') &&
    !(ctx.outcome.reminders ?? []).some((r) => r.status === 'set' && r.deliverTo === 'house')

  // Capture (evidence + facts) — orthogonal to the action, so a reminder that also states a fact is
  // still remembered.
  if (gates.capture && !ctx.outcome.list && !ctx.outcome.olympics && !privateDmReminder) {
    ctx.outcome.captured = await runCapture(step, ctx)
    // The window-append redacted the raw text; the fact layer scans the extracted TRIPLE, which catches
    // more ("wifi is hunter2 now"). A secret the turn detected is never persisted (spec §5).
    const secure = ctx.outcome.captured.secure
    if (secure && windowable) {
      await step.run('window-withhold-secret', () => withholdTurn(createHttpDb(), at, `[a message containing ${secure} — withheld]`))
    }
  }

  if (editMap?.processed) {
    const captured = ctx.outcome.captured
    await step.run('edit-settle', () =>
      settleEditedFacts(createHttpDb(), scope, editMap, {
        produced: captured?.factIds ?? [],
        kept: captured?.keptFactIds ?? [],
        noteId: captured?.memoryItemId ?? null,
      }),
    )
  }

  if (gates.forget) ctx.outcome.forget = await runForget(step, ctx)
  // The tap cancels (functions/callback.ts); this only lists exactly what would go.
  if (gates.cancelReminder) ctx.outcome.cancelReminder = await runCancelReminder(step, ctx)

  // What this message produced, on its window row — the map an edit needs to supersede it (I1). An edit
  // always rewrites it (what the original produced has just been withdrawn or settled).
  const reminderIds = [
    ...(ctx.outcome.reminders ?? []).flatMap((r) => (r.status === 'set' && r.id ? [r.id] : [])),
    // A paused edit kept the original's reminders — they are still this message's (a later edit finds them).
    ...(editMap?.processed && gates.keepRemindersForEdit ? editMap.reminderIds : []),
  ]
  if (scope && (ctx.outcome.captured || reminderIds.length || ctx.edit)) {
    await step.run('window-link', async () => {
      try {
        await linkProduced(createHttpDb(), at, {
          memoryItemId: ctx.outcome.captured?.memoryItemId,
          // An edit that restated the original's own facts still "produced" them — a second edit must find
          // them. (Never another message's fact a turn merely repeated.)
          factIds: [...(ctx.outcome.captured?.factIds ?? []), ...(ctx.outcome.captured?.keptFactIds ?? []).filter((id) => editMap?.factIds.includes(id))],
          reminderIds,
        })
      } catch (err) {
        console.warn('[baumy/ingest] conversation-window link failed:', err instanceof Error ? err.message : err)
      }
    })
  }

  // ONE decision about Baumy's voice, from what the turn is and what actually happened (spec §3).
  const plan = planResponse(ctx, policy)
  await executePlan(step, ctx, plan, { reply: env.reply })
  return { gates, plan }
}
