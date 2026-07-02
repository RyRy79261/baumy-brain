import type { Origin } from './origin'
import { isAllowed } from './policy'

// The confidence gate + write-gate (task-graph I4). The classifier PROPOSES a
// verdict; this deterministic function DISPOSES the action, clamped by the
// action↔origin policy. Untrusted group text can never escalate beyond
// capture / answer / reminder; scheduled tasks + config/admin need a member/owner DM.
export type Decision = 'drop' | 'capture' | 'reply' | 'reminder' | 'task'

export interface Verdict {
  worthRemembering: boolean
  intent: 'chatter' | 'fact' | 'question' | 'reminder' | 'task'
  needsReply: boolean
  confidence: number
}

export interface Thresholds {
  capture: number
  reply: number
  reminder: number
  task: number
}
export const DEFAULT_THRESHOLDS: Thresholds = { capture: 0.5, reply: 0.6, reminder: 0.7, task: 0.7 }

function clampConfidence(c: number): number {
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
}

export function decide(origin: Origin, v: Verdict, th: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (origin.lane === 'ignore') return 'drop'
  const conf = clampConfidence(v.confidence)

  // Each branch is gated by BOTH the classifier intent AND the deterministic policy.
  if (v.intent === 'task' && isAllowed(origin, 'create_scheduled_task') && conf >= th.task) return 'task'
  if (v.intent === 'reminder' && isAllowed(origin, 'create_reminder') && conf >= th.reminder) return 'reminder'
  if (v.needsReply && v.intent === 'question' && isAllowed(origin, 'answer') && conf >= th.reply) return 'reply'
  if (v.worthRemembering && isAllowed(origin, 'capture') && conf >= th.capture) return 'capture'
  return 'drop'
}
