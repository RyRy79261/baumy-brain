import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts } from '@/lib/core/origin'
import { decide } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify, type ClassifierVerdict } from '@/lib/ai/classify'
import { resolveModel } from '@/lib/ai/registry'
import { captureMemory, claimReply, ensureRegistered } from '@/lib/memory/write'
import { retrieve } from '@/lib/memory/retrieve'
import { extractFacts } from '@/lib/ai/extract'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { groundedReply } from '@/lib/ai/reply'
import { baumyLine } from '@/lib/ai/voice'
import { extractReminder } from '@/lib/ai/reminder-extract'
import { parseWhen } from '@/lib/reminders/parse'
import { createReminder } from '@/lib/reminders/store'
import { loadRoster } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { handleCommand } from '@/lib/identity/commands'
import { decryptSecret } from '@/lib/core/crypto'
import { loadResponsePolicy, replyAllowed } from '@/lib/policy'
import { isDirectedAtBaumy } from '@/lib/pipeline/directed'
import { sendToHouse, getBotUsername, reactToMessage } from '@/lib/telegram/client'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// origin (real roster) → member-DM commands OR classify → write-gate → act.
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, messageId, chatId, fromId, text, chatType, isBot, isForwarded, replyToBot } = event.data
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
    const verdict = (await step.run('classify', async () => classify(text ?? ''))) as ClassifierVerdict
    const decision = decide(origin, verdict)

    // "Directed at Baumy" uses the bot's REAL @username (getMe, cached), not a guess.
    const directed = isDirectedAtBaumy(text ?? null, replyToBot === true, await getBotUsername())

    // Capture (evidence + facts) — independent of whether we also reply.
    if (decision === 'capture') {
      await step.run('capture', async () => {
        const db = createHttpDb()
        // Never attribute quarantined (forwarded/bot) content to a housemate.
        const authoredBy = origin.memoryTrust === 'quarantined' || fromId == null ? null : String(fromId)
        await captureMemory(
          { groupId: chatId, content: text ?? '', memoryType: verdict.intent, authoredBy, trustLevel: origin.memoryTrust },
          { db },
        )
        // M2: distil structured facts + trust-gated reconcile into the knowledge
        // graph. Quarantined content never writes a fact (injection wall).
        if (origin.memoryTrust !== 'quarantined') {
          const { facts } = await extractFacts(text ?? '')
          for (const f of facts) {
            await reconcileFact(db, { groupId: chatId, fact: f, authoredBy, trustLevel: origin.memoryTrust })
          }
        }
      })
    }

    // Reminder: AUTO-COMMIT. Baumy reads the message and just sets the reminder,
    // then says so — no click-to-confirm (owner decision: it's a secretary, not a
    // calendar UI). Safe because a reminder only ever posts TEXT to the fixed house
    // group; it can't do anything privileged. (Genuinely privileged/config actions
    // still go through the confirm wall.)
    if (decision === 'reminder') {
      if (!policy.global_enabled) return { updateId, decision: 'drop' as const, reason: 'paused' }
      await step.run('reminder', async () => {
        const db = createHttpDb()
        const ex = await extractReminder(text ?? '')
        if (!ex.isReminder) return
        const parsed = parseWhen(ex.whenText)
        if (!parsed) return
        if (!(await claimReply(db, updateId))) return // one action per inbound (retry-safe)
        const id = await createReminder(db, {
          groupId: chatId,
          deliverChatId: houseChatId, // fixed destination, resolved in code (never LLM)
          content: ex.content,
          fireAt: parsed.fireAt,
          createdBy: fromId != null ? String(fromId) : null,
        })
        await inngest.send({ id: `reminder-arm:${id}`, name: 'reminder/arm.due', data: { reminderId: id } })
        // The acknowledgment is written by the model, not a template — natural,
        // its own words, no robotic date restatement.
        await sendToHouse(
          chatId,
          await baumyLine(
            `A housemate just said: "${text ?? ''}". You quietly set a reminder so the house gets nudged about "${ex.content}" around ${parsed.resolvedLocal}. Let them know you've got it — one short, natural line; you can lightly check it's right.`,
          ),
        )
      })
      return { updateId, decision, directed, intent: verdict.intent, confidence: verdict.confidence, source: origin.source }
    }

    // Reply: a DIRECTED message (@mention / by name / reply-to-Baumy) is always
    // answered; otherwise the triage decides (respond === 'answer'). The model TIER
    // comes from the triage — quick=Haiku, think=Sonnet, deep=Opus. Baumy shows 👀
    // while thinking, then swaps it for the words. Kill-switch silences both.
    const wantReply =
      origin.lane === 'house' &&
      policy.global_enabled &&
      (directed || (verdict.respond === 'answer' && replyAllowed(policy, verdict.confidence, text ?? '')))
    if (wantReply) {
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (chatId !== houseChatId) return // belt-and-suspenders: house group only (E2)
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        await reactToMessage(chatId, messageId, '👀') // seen — thinking
        // Deep (Opus + broad history search) is reserved for real questions; other
        // intents can't burn Opus — clamp a stray 'deep' down to 'think'.
        const tier = verdict.intent === 'question' ? verdict.tier : verdict.tier === 'deep' ? 'think' : verdict.tier
        const deep = tier === 'deep'
        const model = resolveModel(deep ? 'advisor' : tier === 'think' ? 'assess' : 'reply')
        const memories = await retrieve(text ?? '', { groupId: chatId, k: deep ? 30 : 8, floor: deep ? 0.05 : 0.2 }, { db })
        const factHits = await currentFactsForQuery(db, chatId, text ?? '', deep ? 15 : 5)
        const combined = [
          ...factHits.map((f, i) => ({ id: `fact:${i}`, memoryType: 'fact', authoredBy: null, similarity: 1, ...f })),
          ...memories,
        ]
        // Disclosure discretion (memory-core #15): a secure value is decrypted ONLY
        // here, to answer a direct question — never volunteered / in digests.
        const grounding = combined.map((m) =>
          m.isSecure && m.contentEncrypted ? { ...m, content: `${m.content}: ${decryptSecret(m.contentEncrypted)}` } : m,
        )
        await sendToHouse(chatId, await groundedReply(text ?? '', grounding, model))
        await reactToMessage(chatId, messageId, null) // swap the 👀 out — the words are the reply
      })
      return { updateId, decision, directed, tier: verdict.tier, source: origin.source }
    }

    // React-only: a light emoji ack when the triage says a reaction is enough (a
    // noted agreement, a "seen") — no words.
    if (origin.lane === 'house' && policy.global_enabled && verdict.respond === 'react') {
      await reactToMessage(chatId, messageId, verdict.reaction ?? '👍')
    }

    return { updateId, decision, directed, respond: verdict.respond, source: origin.source }
  },
)
