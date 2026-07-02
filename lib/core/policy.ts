import type { Origin } from './origin'

// The closed action set + action↔origin policy (task-graph S5). Deterministic:
// untrusted group text can only ever reach `capture`/`answer`; privileged
// actions require a member DM, and admin/full-config require the owner.
export const ACTIONS = [
  'capture', // write to memory
  'answer', // retrieval-grounded reply into the house group
  'create_reminder',
  'create_scheduled_task',
  'reduce_response_policy', // safe-direction self-config (mute / quiet only)
  'set_response_policy', // full response-policy config (owner)
  'grant_dashboard',
  'admin', // pause / resume / kill-switch
] as const
export type Action = (typeof ACTIONS)[number]

export function allowedActions(o: Origin): Action[] {
  if (o.lane === 'ignore') return []
  // House lane — the injection wall. Capture + answer + reminders only (a reminder
  // fires only into the fixed house group, so it's safe-by-construction). No
  // scheduled tasks (deliberative/cost), no config, no admin.
  if (o.lane === 'house') return ['capture', 'answer', 'create_reminder']

  // Member-DM lane — house-management.
  const base: Action[] = [
    'capture',
    'answer',
    'create_reminder',
    'create_scheduled_task',
    'reduce_response_policy',
  ]
  if (o.source === 'owner') {
    return [...base, 'set_response_policy', 'grant_dashboard', 'admin']
  }
  return base
}

export function isAllowed(o: Origin, action: Action): boolean {
  return allowedActions(o).includes(action)
}
