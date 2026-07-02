import { DateTime } from 'luxon'

// Fail-closed notification gate (task-graph P2). The single decision point for
// proactive output. Reminders are P0 (never gated). Digests respect quiet hours
// (defer). Nudges get full fatigue control (quiet hours + daily cap).
export type NotifyKind = 'reminder' | 'digest' | 'nudge'
export type NotifyDecision = 'send' | 'defer' | 'suppress'

export interface NotifyPolicy {
  quietStartMin: number // minutes from local midnight
  quietEndMin: number
  dailyNudgeCap: number
  tz: string
}

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  quietStartMin: 22 * 60, // 22:00
  quietEndMin: 8 * 60, // 08:00
  dailyNudgeCap: 5,
  tz: 'Europe/Berlin',
}

export function gateNotify(
  kind: NotifyKind,
  nudgesSentToday: number,
  now: DateTime = DateTime.now(),
  policy: NotifyPolicy = DEFAULT_NOTIFY_POLICY,
): NotifyDecision {
  if (kind === 'reminder') return 'send' // P0 — user asked for it; never gated

  const local = now.setZone(policy.tz)
  const min = local.hour * 60 + local.minute
  // Quiet-hours window typically crosses midnight (22:00 → 08:00).
  const inQuiet =
    policy.quietStartMin > policy.quietEndMin
      ? min >= policy.quietStartMin || min < policy.quietEndMin
      : min >= policy.quietStartMin && min < policy.quietEndMin

  if (inQuiet) return 'defer'
  if (kind === 'nudge' && nudgesSentToday >= policy.dailyNudgeCap) return 'suppress'
  return 'send'
}
