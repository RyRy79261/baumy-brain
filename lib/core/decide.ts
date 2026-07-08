import type { Origin } from './origin'
import { isAllowed } from './policy'

// The confidence gate + write-gate (task-graph I4). The classifier PROPOSES a
// verdict; this deterministic function DISPOSES the action, clamped by the
// action↔origin policy. Untrusted group text can never escalate beyond
// capture / answer / reminder; scheduled tasks + config/admin need a member/owner DM.
export type Decision = 'drop' | 'capture' | 'reply' | 'reminder' | 'forget'

export interface Verdict {
  worthRemembering: boolean
  intent: 'chatter' | 'fact' | 'question' | 'reminder' | 'task' | 'forget'
  needsReply: boolean
  confidence: number
}

export interface Thresholds {
  capture: number
  reply: number
  reminder: number
}
export const DEFAULT_THRESHOLDS: Thresholds = { capture: 0.5, reply: 0.6, reminder: 0.7 }

function clampConfidence(c: number): number {
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
}

export function decide(origin: Origin, v: Verdict, th: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (origin.lane === 'ignore') return 'drop'
  const conf = clampConfidence(v.confidence)

  // Each branch is gated by BOTH the classifier intent AND the deterministic policy.
  if (v.intent === 'reminder' && isAllowed(origin, 'create_reminder') && conf >= th.reminder) return 'reminder'
  // "forget X" only PROPOSES a deletion (allowed like answering); the actual delete is
  // gated behind a confirm TAP downstream, so group text can never delete on its own.
  if (v.intent === 'forget' && isAllowed(origin, 'answer') && conf >= th.reply) return 'forget'
  if (v.needsReply && v.intent === 'question' && isAllowed(origin, 'answer') && conf >= th.reply) return 'reply'
  if (v.worthRemembering && isAllowed(origin, 'capture') && conf >= th.capture) return 'capture'
  return 'drop'
}

// Remembering is ORTHOGONAL to the primary action: a message can be a reminder AND
// carry durable house facts ("Zuzana arrives 10pm, staying in my room"). decide()
// returns ONE action, so gating capture on decision==='capture' silently forgot the
// facts in reminder/task/reply messages. Capture whenever it is worth remembering.
export function shouldCapture(origin: Origin, v: Verdict, th: Thresholds = DEFAULT_THRESHOLDS): boolean {
  if (origin.lane === 'ignore') return false
  return v.worthRemembering && isAllowed(origin, 'capture') && clampConfidence(v.confidence) >= th.capture
}

// A shopping-list op (add / check off / query) is a LOW-PRIVILEGE, group-scoped, reversible
// mutation — the capture/reminder tier, NOT the confirm-tap tier (docs/spec/shopping-list.md).
// The classifier PROPOSES the op flag; this disposes whether to act: quarantined (forwarded/bot)
// content can never mutate a list, and a paused GROUP goes silent while a member DM still works
// (pause is lane-scoped, mirroring the DM answer bypass). The caller additionally checks the house
// SCOPE is non-empty (needs houseChatId).
//
// The list op runs on its OWN flag (orthogonal to capture), but it must YIELD to an explicit
// reminder/forget Decision: "remind us to buy bin bags friday" is BOTH intent=reminder and
// list=add, and the reminder is the stated ask — so a list op never preempts it. A list QUERY is
// a question (Decision 'reply'), which we do NOT skip, so "what's on the list?" still renders it.
export function listOpProposed(
  origin: Origin,
  listFlag: 'add' | 'checkoff' | 'query' | 'none',
  policyEnabled: boolean,
  decision: Decision,
): boolean {
  if (origin.lane === 'ignore') return false
  if (listFlag === 'none') return false
  if (decision === 'reminder' || decision === 'forget') return false // explicit action wins
  if (origin.memoryTrust === 'quarantined') return false
  if (!isAllowed(origin, 'mutate_list')) return false
  return origin.lane === 'member_dm' || policyEnabled
}
