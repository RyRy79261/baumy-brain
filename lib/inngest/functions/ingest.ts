import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts, type Roster } from '@/lib/core/origin'
import { decide, type Verdict } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify } from '@/lib/ai/classify'
import { captureMemory, claimReply, ensureRegistered } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { groundedReply } from '@/lib/ai/reply'
import { sendToHouse } from '@/lib/telegram/client'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// nano classify (memoized) → deterministic write-gate → act (capture / reply).
// Secrets/clients are re-resolved INSIDE each step (never across a boundary).
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, chatId, fromId, text, chatType } = event.data
    const houseChatId = process.env.BAUMY_HOUSE_CHAT_ID ?? ''

    await step.run('record-inbound', async () => {
      const db = createHttpDb()
      await db
        .insert(telegramUpdates)
        .values({ updateId, chatId, raw: event.data as unknown as Record<string, unknown> })
        .onConflictDoNothing()
      // Minimal registration (house group + sender) so memory FKs resolve.
      if (chatId === houseChatId) await ensureRegistered(db, chatId, fromId)
    })

    // Deterministic pre-filter — drop obvious noise before any paid LLM call.
    const pf = prefilter(text)
    if (!pf.keep) return { updateId, decision: 'drop' as const, reason: pf.reason }

    // Cheap nano classify (memoized: a retry reuses the same verdict).
    const verdict = (await step.run('classify', async () => classify(text ?? ''))) as Verdict

    // Deterministic origin + write-gate. Classifier proposes; this disposes.
    const roster: Roster = {
      isOwner: (id) => String(id) === (process.env.BAUMY_OWNER_ID ?? ''),
      isMember: () => false, // the DM roster arrives with the auth/binding phase
    }
    const origin = resolveOriginParts({ chatId, fromId, text: text ?? null, isPrivate: chatType === 'private' }, roster)
    const decision = decide(origin, verdict)

    if (decision === 'capture') {
      await step.run('capture', async () => {
        await captureMemory(
          {
            groupId: chatId,
            content: text ?? '',
            memoryType: verdict.intent,
            authoredBy: fromId != null ? String(fromId) : null,
            trustLevel: origin.memoryTrust,
          },
          { db: createHttpDb() },
        )
      })
    } else if (decision === 'reply') {
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        const memories = await retrieve(text ?? '', { groupId: chatId }, { db })
        const answer = await groundedReply(text ?? '', memories)
        await sendToHouse(answer)
      })
    }

    return { updateId, decision, intent: verdict.intent, confidence: verdict.confidence, source: origin.source }
  },
)
