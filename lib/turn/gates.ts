import type { Origin } from '@/lib/core/origin'
import { decide, listOpProposed, olympicsOpProposed, reminderFollowUpAllowed, shouldCapture, type Decision } from '@/lib/core/decide'
import { isSecretQuestion } from '@/lib/core/sensitivity'
import type { ClassifierVerdict } from '@/lib/ai/classify'

// Which of the turn's actions may run — ALL the precedence rules in one place (the turn runner,
// lib/turn/run.ts, executes them in order). The classifier PROPOSES (its verdict); these deterministic
// rules DISPOSE, from transport facts only (lane, trust, directedness, the authenticated author, pause,
// whether this is an edit). Pure: a table test covers every combination that matters ("two actions in
// one message" included), without Inngest, a database or a model.
//
// Some suppressions can only be known once an action has RUN, and live in the runner: a list op or an
// Olympics op that actually happened is not also captured as a note (A11); a reminder asked for in a
// member's own DM that set no HOUSE reminder is private and not captured (D2); a draft completed by a
// follow-up runs the reminder step even without a reminder intent.

export interface GateInput {
  origin: Origin
  verdict: ClassifierVerdict
  /** Telegram-authenticated: the message is FOR Baumy (spec §1). */
  directed: boolean
  /** The housemate the words are attributed to (addressingFor). */
  authorId: string | null
  /** The house scope ('' = none configured — nothing is read or written). */
  scope: string
  /** May the window hold this message (addressingFor) — never another bot's post. */
  windowable: boolean
  /** The owner's kill switch (/pause): false = paused. */
  enabled: boolean
  isEdit: boolean
  /** The message text Baumy reasons over (the @mention stripped). */
  text: string
}

export interface TurnGates {
  decision: Decision
  /** May Baumy act visibly here? A paused GROUP goes silent; a DM still works (pause is lane-scoped). */
  canSpeak: boolean
  /** A forget-looking message is never kept verbatim in the window — keyed on the INTENT, not the
   *  decision: below the confidence bar it is still "forget my number 0176…". */
  withholdForget: boolean
  /** The shopping list op (auto-commit, capture tier). It runs FIRST. */
  list: boolean
  /** A Baumy Olympics op (reads answer, writes are a confirm card). Never on an edit (it never speaks). */
  olympics: boolean
  /** 'ask' = the reminder step runs; 'paused' = it was asked for while paused (an explicit outcome, never a
   *  silent drop); 'none'. Reminders honour /pause in BOTH lanes (they post to the house). */
  reminder: 'ask' | 'paused' | 'none'
  /** May this message complete an earlier reminder still waiting for its time (lib/reminders/draft.ts)? */
  reminderDraft: boolean
  /** Capture (evidence + facts), BEFORE the runner's after-the-fact suppressions. Never a question or
   *  chatter (I3), a forget request (storing "delete X" re-adds X) or a question about a secret (I9). */
  capture: boolean
  /** Forget only PROPOSES (a confirm card) — pointless for an edit, which never speaks. */
  forget: boolean
  /** A reminder cancellation only PROPOSES (a confirm card). Like forget: not on an edit, not while paused. */
  cancelReminder: boolean
  /** While paused an edit cannot re-create a reminder, so the original's are kept (not cancelled). */
  keepRemindersForEdit: boolean
}

export function turnGates(i: GateInput): TurnGates {
  const { origin, verdict: v, directed, authorId, scope, enabled, isEdit } = i
  const decision = decide(origin, v, directed)
  const canSpeak = origin.lane === 'member_dm' || enabled
  return {
    decision,
    canSpeak,
    withholdForget: v.intent === 'forget' && i.windowable,
    list: !!scope && listOpProposed(origin, v.list, enabled, v.intent),
    olympics: !!scope && !isEdit && olympicsOpProposed(origin, v, directed, authorId, enabled),
    reminder: decision !== 'reminder' ? 'none' : enabled ? 'ask' : 'paused',
    reminderDraft: enabled && !!scope && !!authorId && reminderFollowUpAllowed(origin, v, directed, authorId),
    capture: shouldCapture(origin, v) && decision !== 'forget' && !isSecretQuestion(i.text, v.intent),
    forget: decision === 'forget' && canSpeak && !isEdit,
    cancelReminder: decision === 'cancel_reminder' && !!scope && canSpeak && !isEdit,
    keepRemindersForEdit: !enabled,
  }
}
