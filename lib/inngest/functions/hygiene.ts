import { type Database } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { runHygieneSweep } from '@/lib/memory/hygiene'
import { proposeEntityMerges } from '@/lib/ai/dedupe'

// Nightly graph hygiene (docs/spec/chat-understanding-v2.md §7, F12): predicate canonicalisation,
// proven entity merges, model-PROPOSED look-alike merges that code disposes, contradiction resolution
// through the trust gate, and conflict-row retirement (lib/memory/hygiene.ts). Maintenance only — it
// posts nothing, so /pause does not stop it. Scheduled from lib/inngest/schedule.ts ('memory-hygiene').
export async function runHygieneJob(db: Database, at: Date, house?: string) {
  const groupId = house ?? (await getHouseChatId(db))
  if (!groupId) return { skipped: 'no-house' as const }
  return runHygieneSweep(db, groupId, at, { proposeMerges: proposeEntityMerges })
}
