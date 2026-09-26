import { isRelayed, type Origin } from './origin'
import { isAllowed } from './policy'

// The write-gate (task-graph I4, chat-understanding-v2 §2). The classifier PROPOSES a verdict;
// these deterministic functions DISPOSE which ACTIONS may run, clamped by the action↔origin policy.
// Untrusted group text can never escalate beyond capture / answer / reminder / list; scheduled
// tasks + config/admin need a member/owner DM. How Baumy RESPONDS is not decided here — that is the
// response planner (lib/turn/plan.ts), which reads what these actions actually did.
export type Decision = 'drop' | 'capture' | 'reply' | 'reminder' | 'cancel_reminder' | 'forget'

export type Intent = 'statement' | 'question' | 'request' | 'reminder' | 'cancel_reminder' | 'forget' | 'banter' | 'chatter'

export interface Verdict {
  intent: Intent
  worthRemembering: boolean
  /** Confidence in `intent` (I6). */
  confidence: number
}

export interface Thresholds {
  capture: number
  forget: number
}
export const DEFAULT_THRESHOLDS: Thresholds = { capture: 0.5, forget: 0.6 }

function clampConfidence(c: number): number {
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
}

// `directed` = the message is FOR Baumy (a DM, an @mention, a reply to Baumy, the vocative name, the
// ask-Baumy topic) — Telegram-authenticated transport facts, never the text's say-so.
export function decide(origin: Origin, v: Verdict, directed = false, th: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (origin.lane === 'ignore') return 'drop'
  const conf = clampConfidence(v.confidence)
  const forBaumy = directed || origin.lane === 'member_dm'
  // Forwarded/bot content never drives an action (it is not a housemate asking — D4).
  const acts = !isRelayed(origin.memoryTrust)

  // A reminder needs a DIRECTED ask (A9): "remind me to text you about the van" said to a housemate
  // in the group must not post to the whole house tomorrow. NOT confidence-gated (I6): the
  // extractor's isReminder + a resolvable time decide, and a failure is reported, never silent.
  if (v.intent === 'reminder' && acts && forBaumy && isAllowed(origin, 'create_reminder')) return 'reminder'
  // "stop the bins reminder" only PROPOSES a cancellation (docs/spec/reminders.md §Cancelling from chat):
  // the cancel itself is behind a confirm TAP downstream — it removes something the rest of the house may
  // rely on, so it is NOT capture tier like creating one. Same directed-ask wall as a reminder (A9): "ugh,
  // stop reminding me" said to a housemate is not an ask to Baumy. Lanes that may manage reminders only.
  if (v.intent === 'cancel_reminder' && acts && forBaumy && isAllowed(origin, 'create_reminder')) return 'cancel_reminder'
  // "forget X" only PROPOSES a deletion; the actual delete is gated behind a confirm TAP downstream,
  // so group text can never delete on its own.
  if (v.intent === 'forget' && acts && isAllowed(origin, 'answer') && conf >= th.forget) return 'forget'
  if ((v.intent === 'question' || v.intent === 'request') && isAllowed(origin, 'answer')) return 'reply'
  if (shouldCapture(origin, v, th)) return 'capture'
  return 'drop'
}

// May this message COMPLETE an earlier reminder that is still waiting for its time (the answer to
// Baumy's "when should I remind you?" — lib/reminders/draft.ts)? The same wall as a fresh reminder:
// a directed, non-relayed (not forwarded / bot) message from an authenticated sender whose lane may create reminders.
// An explicit forget, reminder cancellation or list op is its own action and never doubles as the follow-up. Whether it
// really answers the question is the extractor's call; this only decides whether to look.
export function reminderFollowUpAllowed(origin: Origin, v: Pick<Verdict, 'intent'> & { list?: string }, directed: boolean, authorId: string | null): boolean {
  if (origin.lane === 'ignore' || !authorId) return false
  if (!(directed || origin.lane === 'member_dm')) return false
  if (isRelayed(origin.memoryTrust)) return false
  if (v.intent === 'forget' || v.intent === 'cancel_reminder' || (v.list != null && v.list !== 'none')) return false
  return isAllowed(origin, 'create_reminder')
}

// What is worth storing as EVIDENCE (I3): statements, and requests/reminders that carry house info —
// never a question (it would later ground an answer as if it were a fact: "Marco mentioned the
// plumber coming Thursday" from Marco's own question), never chatter/banter, never a forget request
// (storing "delete X" re-adds X). Orthogonal to the primary action: a reminder that also states a
// fact ("Zofia arrives 10pm, staying in my room") is still remembered.
const CAPTURABLE: ReadonlySet<Intent> = new Set(['statement', 'request', 'reminder'])

export function shouldCapture(origin: Origin, v: Verdict, th: Thresholds = DEFAULT_THRESHOLDS): boolean {
  if (origin.lane === 'ignore') return false
  // A FORWARDED message (D4) is someone else's words passed on — the landlord's "can someone be home
  // Tuesday 10am?" is house info even though it is phrased as a question, so its intent label does not
  // gate it; worthRemembering does. It is stored labelled and never becomes a fact (capture.ts).
  if (origin.memoryTrust === 'forwarded')
    return v.worthRemembering && v.intent !== 'forget' && isAllowed(origin, 'capture') && clampConfidence(v.confidence) >= th.capture
  if (!CAPTURABLE.has(v.intent)) return false
  return v.worthRemembering && isAllowed(origin, 'capture') && clampConfidence(v.confidence) >= th.capture
}

// A shopping-list op (add / check off / query) is a LOW-PRIVILEGE, group-scoped, reversible
// mutation — the capture/reminder tier, NOT the confirm-tap tier (docs/spec/shopping-list.md).
// The classifier PROPOSES the op flag; this disposes whether to act: relayed (forwarded/bot)
// content can never mutate a list, and a paused GROUP goes silent while a member DM still works
// (pause is lane-scoped, mirroring the DM answer bypass). The caller additionally checks the house
// SCOPE is non-empty (needs houseChatId).
//
// The list op runs on its OWN flag (orthogonal to capture), but it must YIELD to an explicit
// reminder/forget: "remind us to buy bin bags friday" is BOTH intent=reminder and list=add, and the
// reminder is the stated ask — so a list op never preempts it (even when the reminder itself is not
// created because the ask was undirected — A9 — the list must not silently act on it instead).
export function listOpProposed(
  origin: Origin,
  listFlag: 'add' | 'checkoff' | 'query' | 'none',
  policyEnabled: boolean,
  intent: Intent,
): boolean {
  if (origin.lane === 'ignore') return false
  if (listFlag === 'none') return false
  if (intent === 'reminder' || intent === 'cancel_reminder' || intent === 'forget') return false // explicit action wins
  if (isRelayed(origin.memoryTrust)) return false
  if (!isAllowed(origin, 'mutate_list')) return false
  return origin.lane === 'member_dm' || policyEnabled
}
