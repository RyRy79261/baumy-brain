import { type Database } from '@/db/client'
import { purgeWindow } from '@/lib/turn/window'

// The conversation window's retention bound (docs/spec/chat-understanding-v2.md §5, D1): recent chat
// text is kept 48h and no longer. Hourly, so a row outlives its 48h by at most an hour — and every
// window READ also filters by 48h, so a late or failed purge never shows an old turn. Not paused by
// /pause: it is housekeeping (a privacy bound), not proactive output. Scheduled from
// lib/inngest/schedule.ts ('conversation-window-purge').
export async function runWindowPurgeJob(db: Database, at: Date) {
  return { purged: await purgeWindow(db, at) }
}
