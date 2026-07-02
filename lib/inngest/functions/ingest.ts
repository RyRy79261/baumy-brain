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
import { createPendingAction } from '@/lib/confirm/store'
import { loadRoster } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { handleCommand } from '@/lib/identity/commands'
import { decryptSecret } from '@/lib/core/crypto'
import { loadResponsePolicy, replyAllowed } from '@/lib/policy'
import { sendToHouse, sendConfirmCard } from '@/lib/telegram/client'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// origin (real roster) → member-DM commands OR classify → write-gate → act.
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, chatId, fromId, text, chatType, isBot, isForwarded } = event.data
    // House group id from house_config (captured on bot-add); env override wins.
    const houseChatId = await getHouseChatId(createHttpDb())
    // Owner-configurable response policy (kill-switch / confidence floor / mutes).
    const policy = await loadResponsePolicy(createHttpDb())

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
    const origin = resolveOriginParts(
      { chatId, fromId, text: text ?? null, isPrivate: chatType === 'private', isBot, isForwarded },
      roster,
      houseChatId,
    )

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
            // Never attribute quarantined (forwarded/bot) content to a housemate.
            authoredBy: origin.memoryTrust === 'quarantined' || fromId == null ? null : String(fromId),
            trustLevel: origin.memoryTrust,
          },
          { db: createHttpDb() },
        )
      })
    } else if (decision === 'reply' && origin.lane === 'house') {
      // Owner response-policy gate: kill-switch / confidence floor / muted topics.
      if (!replyAllowed(policy, verdict.confidence, text ?? '')) {
        return { updateId, decision: 'drop' as const, reason: 'response-policy' }
      }
      // Retrieval-grounded replies only ever go INTO the house group.
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (chatId !== houseChatId) return // belt-and-suspenders: house group only (E2)
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        const memories = await retrieve(text ?? '', { groupId: chatId }, { db })
        // Disclosure discretion (memory-core #15): a secure value is decrypted
        // ONLY here, to answer a member's direct question — never volunteered
        // elsewhere and never in digests/broadcasts.
        const grounding = memories.map((m) =>
          m.isSecure && m.contentEncrypted ? { ...m, content: `${m.content}: ${decryptSecret(m.contentEncrypted)}` } : m,
        )
        await sendToHouse(chatId, await groundedReply(text ?? '', grounding))
      })
    } else if (decision === 'reminder') {
      if (!policy.global_enabled) return { updateId, decision: 'drop' as const, reason: 'paused' }
      await step.run('reminder-propose', async () => {
        const db = createHttpDb()
        const ex = await extractReminder(text ?? '')
        if (!ex.isReminder) return
        const parsed = parseWhen(ex.whenText)
        if (!parsed) return
        // Privileged action (security gate): a reminder is a PRIVILEGED effect, so
        // group text can only PROPOSE it. Post a confirm card; the reminder is
        // created only when a member taps ✅ (handled in functions/callback.ts).
        const actionId = await createPendingAction(db, {
          groupId: chatId,
          actionType: 'reminder.create',
          payload: {
            deliverChatId: houseChatId, // fixed destination, resolved in code (never LLM)
            content: ex.content,
            fireAt: parsed.fireAt.toISOString(),
            createdBy: fromId != null ? String(fromId) : null,
            resolvedLocal: parsed.resolvedLocal,
          },
          requestedBy: fromId != null ? String(fromId) : null,
          ttlSec: 3600,
        })
        await sendConfirmCard(chatId, `Set a reminder — "${ex.content}" on ${parsed.resolvedLocal}? Tap to confirm.`, actionId)
      })
    }

    return { updateId, decision, intent: verdict.intent, confidence: verdict.confidence, source: origin.source }
  },
)
