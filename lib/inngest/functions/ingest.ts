import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts, type Roster } from '@/lib/core/origin'
import { decide, type Verdict } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify } from '@/lib/ai/classify'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// nano classify (memoized) → deterministic write-gate decision. Phase 2 LOGS the
// decision; the actual memory write / reply / reminder land in Phases 3–4.
// Secrets/clients are re-resolved INSIDE each step (never across a boundary).
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, chatId, fromId, text, chatType } = event.data

    await step.run('record-inbound', async () => {
      const db = createHttpDb()
      await db
        .insert(telegramUpdates)
        .values({ updateId, chatId, raw: event.data as unknown as Record<string, unknown> })
        .onConflictDoNothing()
    })

    // Deterministic pre-filter — drop obvious noise before any paid LLM call.
    const pf = prefilter(text)
    if (!pf.keep) return { updateId, decision: 'drop' as const, reason: pf.reason }

    // Cheap nano classify (memoized: a retry reuses the same verdict, so the
    // LLM is called at most once and downstream stays deterministic).
    const verdict = (await step.run('classify', async () => classify(text ?? ''))) as Verdict

    // Deterministic origin + write-gate. Classifier proposes; this disposes.
    const roster: Roster = {
      isOwner: (id) => String(id) === (process.env.BAUMY_OWNER_ID ?? ''),
      isMember: () => false, // the DM roster arrives with the auth/binding phase
    }
    const origin = resolveOriginParts({ chatId, fromId, text: text ?? null, isPrivate: chatType === 'private' }, roster)
    const decision = decide(origin, verdict)

    // Phase 2: log-only. Phase 3 turns 'capture'/'reply' into real memory + replies.
    return { updateId, decision, intent: verdict.intent, confidence: verdict.confidence, source: origin.source }
  },
)
