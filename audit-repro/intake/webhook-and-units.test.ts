import { describe, it, expect } from 'vitest'
import { replyAllowed, type ResponsePolicy } from '@/lib/policy'

// AUDIT REPRO — pure intake units still open. (The webhook-mapping repros — captions dropped (I4), edits
// forwarded with no marker (I1) — are fixed in phase 5: app/api/telegram/webhook/__tests__/webhook.test.ts,
// lib/telegram/__tests__/content.test.ts and scenarios/intake-actions.scenario.test.ts.)

describe('AUDIT intake units', () => {
  // (E20/I6 "needsReply undefined, confidence meaningless" fixed in phase 1: the spec §2 schema drops
  // needsReply and TRIAGE_SYSTEM defines confidence as confidence in the intent.)
  // STILL OPEN — I6, second half (→ unscheduled; spec §3 "known deviation"): the planner's undirected
  // row gates on replyAllowed(policy, verdict.confidence), i.e. certainty of the INTENT, not how useful
  // a reply would be. This asserts the current (buggy) behaviour; delete it when the floor is fixed.
  it('I6 (open): reply floor compares the TRIAGE confidence (certainty of classification) against "how meaningful" thresholds', () => {
    const p: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [], reply_frequency: 'quiet', reminder_frequency: 'twice' }
    // an obvious rhetorical/banter question the classifier is very SURE about clears the "quiet" floor
    expect(replyAllowed(p, 0.95, 'who even ate my yogurt lol?')).toBe(true)
    // a genuinely useful but ambiguous-intent question is silenced
    expect(replyAllowed(p, 0.8, 'is the plumber still coming or')).toBe(false)
  })
})
