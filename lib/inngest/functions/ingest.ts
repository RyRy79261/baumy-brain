import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts } from '@/lib/core/origin'
import { decide, shouldCapture } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify, type ClassifierVerdict } from '@/lib/ai/classify'
import { captureMemory, claimReply, ensureRegistered } from '@/lib/memory/write'
import { retrieve, retrieveExpanded, type RetrievedMemory } from '@/lib/memory/retrieve'
import { extractFacts } from '@/lib/ai/extract'
import { reconcileFact, currentFactsForQuery } from '@/lib/memory/facts'
import { answer } from '@/lib/ai/reply'
import { expandQuery } from '@/lib/ai/expand'
import { rerank } from '@/lib/ai/rerank'
import { extractReminder } from '@/lib/ai/reminder-extract'
import { parseWhen } from '@/lib/reminders/parse'
import { createReminder } from '@/lib/reminders/store'
import { loadRoster, memberDisplayNames } from '@/lib/identity/roster'
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

    // Capture (evidence + facts) — ORTHOGONAL to the reply/reminder/task action, so a
    // reminder that also states a fact ("Zuzana arrives 10pm, staying in my room") is
    // still remembered (previously it was silently forgotten).
    if (shouldCapture(origin, verdict)) {
      await step.run('capture', async () => {
        const db = createHttpDb()
        // Never attribute quarantined (forwarded/bot) content to a housemate.
        const authoredBy = origin.memoryTrust === 'quarantined' || fromId == null ? null : String(fromId)
        await captureMemory(
          { groupId: chatId, content: text ?? '', memoryType: verdict.intent, authoredBy, trustLevel: origin.memoryTrust },
          { db },
        )
        // M2: distil structured facts + trust-gated reconcile into the knowledge
        // graph. Quarantined content never writes a fact (injection wall). The
        // speaker's name lets first-person references resolve ("my room" → their room).
        if (origin.memoryTrust !== 'quarantined') {
          const speaker = authoredBy ? ((await memberDisplayNames(db)).get(authoredBy) ?? null) : null
          const { facts } = await extractFacts(text ?? '', speaker)
          for (const f of facts) {
            await reconcileFact(db, { groupId: chatId, fact: f, authoredBy, trustLevel: origin.memoryTrust })
          }
        }
      })
    }

    // Reminder: AUTO-COMMIT the ACTION (no click-to-confirm — safe, a reminder only
    // posts TEXT to the fixed house group). The acknowledgement is the unified voice
    // below (usually just a 👍).
    let reminderSet = false
    if (decision === 'reminder' && policy.global_enabled) {
      reminderSet = await step.run('reminder', async () => {
        const db = createHttpDb()
        const ex = await extractReminder(text ?? '')
        if (!ex.isReminder) return false
        const parsed = parseWhen(ex.whenText)
        if (!parsed) return false
        const id = await createReminder(db, {
          groupId: chatId,
          deliverChatId: houseChatId, // fixed destination, resolved in code (never LLM)
          content: ex.content,
          fireAt: parsed.fireAt,
          createdBy: fromId != null ? String(fromId) : null,
        })
        // Best-effort arm; the sweeper backstops delivery, so a hand-off failure
        // here never retries the step into a duplicate reminder.
        try {
          await inngest.send({ id: `reminder-arm:${id}`, name: 'reminder/arm.due', data: { reminderId: id } })
        } catch {
          /* sweeper still delivers */
        }
        return true
      })
    }

    // ── VOICE: ONE decision, made by the model — nothing, an emoji, or words.
    // Rule: emoji by DEFAULT; words ONLY when they carry info an emoji can't (a real
    // question, or banter aimed at Baumy). A directed message always gets a reply;
    // the model picks the tier and self-escalates. 👀 while thinking, swapped for the
    // words. A set reminder gets at least a 👍. Kill-switch silences everything.
    const canSpeak = origin.lane === 'house' && policy.global_enabled
    const wantAnswer =
      canSpeak && (directed || (verdict.respond === 'answer' && replyAllowed(policy, verdict.confidence, text ?? '')))

    if (wantAnswer) {
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (chatId !== houseChatId) return // belt-and-suspenders: house group only (E2)
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        await reactToMessage(chatId, messageId, '👀') // seen — thinking
        // Deep (broad history search) only for real questions; clamp a stray 'deep'.
        const startTier = verdict.intent === 'question' ? verdict.tier : verdict.tier === 'deep' ? 'think' : verdict.tier
        const deep = startTier === 'deep'
        // Deep tier earns query expansion (wider recall) + a Haiku re-rank (precision);
        // both best-effort, degrading to plain hybrid retrieval on any hiccup.
        let memories: RetrievedMemory[]
        if (deep) {
          let expansions: string[] = []
          try {
            expansions = await expandQuery(text ?? '')
          } catch {
            /* fall back to the raw query */
          }
          memories = expansions.length
            ? await retrieveExpanded(text ?? '', expansions, { groupId: chatId, k: 30, floor: 0.05 }, { db })
            : await retrieve(text ?? '', { groupId: chatId, k: 30, floor: 0.05 }, { db })
          try {
            memories = await rerank(text ?? '', memories)
          } catch {
            /* keep the fusion order */
          }
        } else {
          memories = await retrieve(text ?? '', { groupId: chatId, k: 8, floor: 0.2 }, { db })
        }
        const factHits = await currentFactsForQuery(db, chatId, text ?? '', deep ? 15 : 5)
        // Show authors by NAME (not raw id) so the model can attribute + resolve
        // first-person pronouns in retrieved notes ("from Charl … my room" → Charl's).
        const names = await memberDisplayNames(db)
        const combined = [
          ...factHits.map((f, i) => ({ id: `fact:${i}`, memoryType: 'fact', authoredBy: null, similarity: 1, ...f })),
          ...memories.map((m) => ({ ...m, authoredBy: m.authoredBy ? (names.get(m.authoredBy) ?? m.authoredBy) : null })),
        ]
        // Disclosure discretion (memory-core #15): a secure value is decrypted ONLY
        // here, to answer a direct question — never volunteered / in digests.
        const grounding = combined.map((m) =>
          m.isSecure && m.contentEncrypted ? { ...m, content: `${m.content}: ${decryptSecret(m.contentEncrypted)}` } : m,
        )
        // Start at the triage tier; the model self-escalates only if it needs to.
        const { text: reply } = await answer(text ?? '', grounding, startTier)
        await sendToHouse(chatId, reply)
        await reactToMessage(chatId, messageId, null) // swap the 👀 out — the words are the reply
      })
    } else if (canSpeak && (verdict.respond === 'react' || reminderSet)) {
      // Emoji is plenty; a set reminder gets at least a 👍 so it's confirmed.
      await reactToMessage(chatId, messageId, verdict.reaction ?? '👍')
    }

    return { updateId, decision, directed, respond: verdict.respond, reminderSet, source: origin.source }
  },
)
