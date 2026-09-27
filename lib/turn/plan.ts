import { replyAllowed, type ResponsePolicy } from '@/lib/policy'
import { NOTED, type PlannerEmoji } from './emoji'
import type { TurnContext, ListOutcome } from './context'

// The response planner (docs/spec/chat-understanding-v2.md §3). ONE pure function decides Baumy's
// voice for a turn — nothing, a reaction, or words in a named MODE — from what the turn IS (lane,
// directedness, the classifier's verdict) and what actually HAPPENED (ctx.outcome). No I/O, no LLM,
// table-driven and exhaustively unit-tested (lib/turn/__tests__/plan.test.ts): the old voice logic
// was an if/else chain threaded through ingest, which is how a statement ended up "answered" as a
// question (C3/C4) and a failed reminder got a "noted" (A2).
//
// The planner only chooses the SHAPE. The words themselves are the reply model's (lib/ai/reply.ts),
// told the MODE and THIS TURN; deterministic list/forget texts come from their stores.

export type ReplyMode = 'answer' | 'ack' | 'clarify' | 'confirm' | 'banter'

/** Which row of the spec §3 table fired — for tests, logs and the ingest return value. */
export type PlanRow =
  | 'paused'
  | 'quarantined'
  | 'forwarded'
  | 'forwarded-captured'
  | 'forwarded-dm'
  | 'edit-silent'
  | 'edit-noted'
  | 'edit-reminder'
  | 'forget'
  | 'cancel-reminder'
  | 'cancel-reminder-unmatched'
  | 'cancel-reminder-which'
  | 'cancel-reminder-undirected'
  | 'list'
  | 'olympics'
  | 'reminder-set'
  | 'reminder-set-undirected'
  | 'reminder-failed'
  | 'reminder-failed-undirected'
  | 'reminder-undirected'
  | 'reminder-not-extracted'
  | 'reminder-paused'
  | 'degraded-directed'
  | 'degraded'
  | 'ask-directed'
  | 'ask-console-housemates'
  | 'ask-undirected'
  | 'ask-undirected-below-floor'
  | 'ask-housemates'
  | 'statement-conflict'
  | 'statement-directed'
  | 'statement-captured'
  | 'banter-directed'
  | 'vibe'
  | 'otherwise'

export type Plan =
  | { kind: 'none'; row: PlanRow }
  | { kind: 'react'; emoji: PlannerEmoji; row: PlanRow }
  /** `onMiss`: what to do if the model admits it has nothing — words (directed) or a 👎 (ambient). */
  | { kind: 'words'; mode: ReplyMode; alsoReact?: PlannerEmoji; onMiss?: 'words' | '👎'; row: PlanRow }
  /** The deterministic shopping-list ack (rendered from the store outcome — K4). */
  | { kind: 'list-words'; row: 'list' }
  /** The forget flow: the confirm card, or the deterministic "nothing to forget" line. */
  | { kind: 'forget'; row: 'forget' }
  /** A Baumy Olympics op: its confirm card, or the deterministic line (a read's answer, or why not). */
  | { kind: 'olympics'; row: 'olympics' }
  /** Reminder cancellation proposed: the deterministic confirm card listing exactly what would go. */
  | { kind: 'cancel-reminder'; row: 'cancel-reminder' }
  /** A message a member forwarded to Baumy's DM (D4): the deterministic "filed it, as forwarded by you"
   *  line — the reply model never voices someone else's words back as a conversation turn. */
  | { kind: 'forward-ack'; row: 'forwarded-dm' }

const none = (row: PlanRow): Plan => ({ kind: 'none', row })
const react = (emoji: PlannerEmoji, row: PlanRow): Plan => ({ kind: 'react', emoji, row })
const words = (mode: ReplyMode, row: PlanRow, extra: { alsoReact?: PlannerEmoji; onMiss?: 'words' | '👎' } = {}): Plan => ({
  kind: 'words',
  mode,
  row,
  ...extra,
})

// The list ack from the STORE OUTCOME, never the op alone (K4):
//   group add:      something new went on → ✍;  everything already there → 👀 (the list is right).
//   group checkoff: everything named was ticked → 👍;  anything NOT found → words (what was ticked,
//                   what wasn't on the list, what's left) — silence there lets someone buy twice.
//   a query (either lane), any DM op → words.
function listAck(l: ListOutcome, dm: boolean): { react: PlannerEmoji } | 'words' {
  if (l.op === 'query' || dm) return 'words'
  if (l.op === 'add') return { react: l.added.length > 0 ? NOTED : '👀' }
  return l.notFound.length === 0 && l.checkedOff.length > 0 ? { react: '👍' } : 'words'
}

export function planResponse(ctx: TurnContext, policy: ResponsePolicy): Plan {
  const plan = planTurn(ctx, policy)
  return ctx.edit ? quietForEdit(plan, ctx) : plan
}

// An EDIT never gets words (spec §8, I1): the original was already answered (or, if Baumy never saw
// it, a reply now would land under a message people read hours ago). What the edit changed still
// happens — capture, a re-set reminder — and may show as a reaction on the edited message: 👍 for a
// reminder (re)set, ✍ for something (re)noted. The worded confirm of the new time is the one thing
// lost; /reminders shows it.
function quietForEdit(plan: Plan, ctx: TurnContext): Plan {
  if (plan.kind === 'none' || plan.kind === 'react') return plan
  if (ctx.outcome.reminder?.status === 'set') return react('👍', 'edit-reminder')
  if (plan.kind === 'words' && plan.alsoReact) return react(plan.alsoReact, 'edit-noted')
  if (ctx.outcome.captured && !ctx.outcome.captured.conflicts?.length) return react(NOTED, 'edit-noted')
  return none('edit-silent')
}

function planTurn(ctx: TurnContext, policy: ResponsePolicy): Plan {
  const dm = ctx.lane === 'member_dm'
  // Pause (/pause, the kill-switch) silences the GROUP; a private DM pollutes nothing, so it still
  // works (the bypass is lane-scoped).
  if (ctx.lane === 'house' && !policy.global_enabled) return none('paused')
  // A member-FORWARDED message (D4) is someone else's words, not a housemate talking to Baumy: it never
  // gets an answer. In the group a kept one is ✍ (it IS recallable now); in a DM the forwarder hears
  // that it was filed (deterministic line, respond.ts).
  if (ctx.trust === 'forwarded') {
    if (dm) return { kind: 'forward-ack', row: 'forwarded-dm' }
    return ctx.outcome.captured ? react(NOTED, 'forwarded-captured') : none('forwarded')
  }
  // Bot content is never a housemate talking to Baumy: no voice at all.
  if (ctx.trust === 'quarantined') return none('quarantined')

  const v = ctx.verdict
  const o = ctx.outcome
  const directed = ctx.directed.value || dm

  // Forget: the flow already ran (proposal card, or why there is nothing to confirm). A message the
  // extractor did NOT read as a forget request falls through to the question rows below.
  if (o.forget && !(o.forget.proposed === false && o.forget.reason === 'not_forget')) return { kind: 'forget', row: 'forget' }

  // Cancel a reminder: a card was proposed (nothing cancelled until a tap), or the reply model says why
  // not — told in THIS TURN that NOTHING was cancelled, with what IS scheduled (nothing matched) or the
  // candidates to choose from (ambiguous / unsaid). A message the extractor did NOT read as a
  // cancellation falls through to the ordinary rows below.
  const c = o.cancelReminder
  if (c && !(c.proposed === false && c.reason === 'not_cancel')) {
    if (c.proposed) return { kind: 'cancel-reminder', row: 'cancel-reminder' }
    return c.reason === 'nothing' ? words('answer', 'cancel-reminder-unmatched', { onMiss: 'words' }) : words('clarify', 'cancel-reminder-which')
  }

  // Baumy Olympics (docs/spec/olympics.md): only ever run for a directed ask, so it always answers —
  // the card, or the deterministic line. Never the reply model.
  if (o.olympics) return { kind: 'olympics', row: 'olympics' }

  const main = planMain(ctx, policy, directed)

  // List op handled: ack from the store outcome — unless the message ALSO asks something (A10), in
  // which case the question is answered and the list outcome rides along (a reaction, or in THIS
  // TURN for the reply model when the ack would have needed words).
  if (o.list) {
    const ack = listAck(o.list, dm)
    const alsoAsks = o.list.op !== 'query' && v?.intent === 'question' && main.kind === 'words' && main.mode === 'answer'
    if (alsoAsks && main.kind === 'words') return { ...main, ...(ack !== 'words' ? { alsoReact: ack.react } : {}) }
    return ack === 'words' ? { kind: 'list-words', row: 'list' } : react(ack.react, 'list')
  }
  return main
}

function planMain(ctx: TurnContext, policy: ResponsePolicy, directed: boolean): Plan {
  const v = ctx.verdict
  const o = ctx.outcome

  // Reminder outcomes. A set reminder is confirmed IN WORDS with the resolved day+time when it was
  // asked for directly, so a misparse is visible; a failed one is a clarifying question — never a
  // "noted" (A2/A3). Undirected reminders are not created at all (A9), so those rows are silent.
  if (o.reminder) {
    if (o.reminder.status === 'set') return directed ? words('confirm', 'reminder-set') : react('👍', 'reminder-set-undirected')
    // Asked while the house is paused (only a DM gets this far — a paused group is silent above):
    // nothing to clarify, so answer honestly with THIS TURN saying why nothing was scheduled.
    if (o.reminder.status === 'paused') return directed ? words('answer', 'reminder-paused', { onMiss: 'words' }) : none('reminder-undirected')
    return directed ? words('clarify', 'reminder-failed') : none('reminder-failed-undirected')
  }
  if (v?.intent === 'reminder') {
    // Directed, but the extractor did not find a reminder in it → treat it as an ask; the reply is
    // told nothing was scheduled. Undirected → silence (never a ✍ on an action that was dropped — I6).
    return directed ? words('answer', 'reminder-not-extracted', { onMiss: 'words' }) : none('reminder-undirected')
  }

  // Triage produced no usable verdict (K5): answer what was plainly for Baumy, ignore the rest.
  if (!v || v.degraded) return directed ? words('answer', 'degraded-directed', { onMiss: 'words' }) : none('degraded')

  switch (v.intent) {
    case 'cancel_reminder':
      // Undirected, the cancellation never ran (A9 wall) — silence; a directed one that the extractor
      // did not read as a cancellation is an ordinary ask (the case below).
      if (!directed) return none('cancel-reminder-undirected')
    // falls through
    case 'question':
    case 'request':
    case 'forget': // the extractor said it was not a forget request after all → an ordinary ask
      if (directed) {
        // In the ask-Baumy topic everything is "directed", so housemates asking EACH OTHER there
        // would all get Baumy's two cents; the classifier's addressee judgement decides (C6).
        if (ctx.directed.why === 'console_topic' && !v.asksBaumy) return none('ask-console-housemates')
        return words('answer', 'ask-directed', { onMiss: 'words' })
      }
      // An info-carrying request whose fact was refused as a conflict: ask, never silence (spec §7).
      if (o.captured?.conflicts?.length) return words('clarify', 'statement-conflict')
      if (!v.asksBaumy) return none('ask-housemates') // housemates talking to each other (C6)
      // An unaddressed question to the house: only when the owner's reply floor + muted topics allow,
      // and an honest miss is a quiet 👎 — never a line of "no idea" into the group. The floor reads
      // how useful triage thinks an answer would be (`replyValue`), never its certainty about the
      // intent (I6, second half).
      return replyAllowed(policy, v.replyValue, ctx.text)
        ? words('answer', 'ask-undirected', { onMiss: '👎' })
        : none('ask-undirected-below-floor')
    case 'statement':
      // It contradicts a fact the speaker may not override (spec §7, F5): the correction was kept but
      // NOT made current, so Baumy asks which is right — never a ✍ that claims it was taken. This is
      // one of the few rows that speaks undirected: silently ignoring a correction is the worse failure.
      if (o.captured?.conflicts?.length) return words('clarify', 'statement-conflict')
      if (directed) return words('ack', 'statement-directed')
      if (o.captured) return react(NOTED, 'statement-captured')
      return v.vibe ? react(v.vibe, 'vibe') : none('otherwise')
    case 'banter':
      if (directed) return words('banter', 'banter-directed')
      return v.vibe ? react(v.vibe, 'vibe') : none('otherwise')
    case 'chatter':
      return v.vibe ? react(v.vibe, 'vibe') : none('otherwise')
  }
  return none('otherwise')
}
