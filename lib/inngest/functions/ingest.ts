import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts } from '@/lib/core/origin'
import { decide, type Verdict } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify } from '@/lib/ai/classify'
import { captureMemory, claimReply, ensureRegistered } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { groundedReply } from '@/lib/ai/reply'
import { extractReminder } from '@/lib/ai/reminder-extract'
import { parseWhen } from '@/lib/reminders/parse'
import { createReminder } from '@/lib/reminders/store'
import { loadRoster } from '@/lib/identity/roster'
import { handleCommand } from '@/lib/identity/commands'
import { sendToHouse } from '@/lib/telegram/client'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// origin (real roster) → member-DM commands OR classify → write-gate → act.
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
      if (chatId === houseChatId) await ensureRegistered(db, chatId, fromId)
    })

    const pf = prefilter(text)
    if (!pf.keep) return { updateId, decision: 'drop' as const, reason: pf.reason }

    // Real roster (fail-closed) + deterministic origin — before any LLM call.
    const roster = await loadRoster(createHttpDb())
    const origin = resolveOriginParts({ chatId, fromId, text: text ?? null, isPrivate: chatType === 'private' }, roster)

    // Member-DM commands (house-management). Deterministic; no classify/LLM.
    if (origin.lane === 'member_dm' && (text ?? '').trim().startsWith('/')) {
      await step.run('command', async () => handleCommand(origin, text ?? ''))
      return { updateId, decision: 'command' as const }
    }
    if (origin.lane === 'ignore') return { updateId, decision: 'drop' as const, reason: 'out-of-scope' }

    // Cheap nano classify (memoized) → write-gate decision.
    const verdict = (await step.run('classify', async () => classify(text ?? ''))) as Verdict
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
    } else if (decision === 'reply' && origin.lane === 'house') {
      // Retrieval-grounded replies only ever go INTO the house group.
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        const memories = await retrieve(text ?? '', { groupId: chatId }, { db })
        await sendToHouse(await groundedReply(text ?? '', memories))
      })
    } else if (decision === 'reminder') {
      await step.run('reminder', async () => {
        const db = createHttpDb()
        const ex = await extractReminder(text ?? '')
        if (!ex.isReminder) return
        const parsed = parseWhen(ex.whenText)
        if (!parsed) return
        const id = await createReminder(db, {
          groupId: chatId,
          deliverChatId: houseChatId, // fixed destination, resolved in code (never LLM)
          content: ex.content,
          fireAt: parsed.fireAt,
          createdBy: fromId != null ? String(fromId) : null,
        })
        await sendToHouse(`Got it — I'll remind the house: "${ex.content}" on ${parsed.resolvedLocal}.`)
        await inngest.send({ id: `reminder-arm:${id}`, name: 'reminder/arm.due', data: { reminderId: id } })
      })
    }

    return { updateId, decision, intent: verdict.intent, confidence: verdict.confidence, source: origin.source }
  },
)
