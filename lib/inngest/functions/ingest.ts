import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'

// The reactive ingest pipeline entry (architecture D10). Phase 1 lands the
// idempotent `record-inbound` step (the beyond-24h dedup backstop). Phase 2
// adds `classify` → remember / reply / reminder / deliberate as further steps.
// Secrets/clients are re-resolved INSIDE each step (never across a boundary).
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, chatId } = event.data

    await step.run('record-inbound', async () => {
      const db = createHttpDb()
      await db
        .insert(telegramUpdates)
        .values({
          updateId,
          chatId,
          raw: event.data as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing()
    })

    // Phase 2: classify (OpenAI nano) → conditional remember / reply / reminder /
    // emit deliberation-requested. All gated by lib/core (resolveOrigin + policy).
    return { recorded: updateId }
  },
)
