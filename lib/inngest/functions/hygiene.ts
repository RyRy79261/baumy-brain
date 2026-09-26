import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { getHouseChatId } from '@/lib/identity/house'
import { now as clockNow } from '@/lib/core/clock'
import { runHygieneSweep } from '@/lib/memory/hygiene'
import { proposeEntityMerges } from '@/lib/ai/dedupe'

// Nightly graph hygiene (docs/spec/chat-understanding-v2.md §7, F12): predicate canonicalisation,
// proven entity merges, model-PROPOSED look-alike merges that code disposes, contradiction resolution
// through the trust gate, and conflict-row retirement (lib/memory/hygiene.ts). Maintenance only — it
// posts nothing, so /pause does not stop it. 03:40 Berlin: after the day's traffic, before the 07:45
// surfacing scan reads the facts.
export const hygieneSweep = inngest.createFunction(
  { id: 'memory-hygiene', retries: 1 },
  { cron: 'TZ=Europe/Berlin 40 3 * * *' },
  async ({ step }) => {
    return step.run('hygiene', async () => {
      const db = createHttpDb()
      const groupId = await getHouseChatId(db)
      if (!groupId) return { skipped: 'no-house' as const }
      return runHygieneSweep(db, groupId, clockNow(), { proposeMerges: proposeEntityMerges })
    })
  },
)
