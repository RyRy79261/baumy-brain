import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts } from '@/lib/core/origin'
import { decide, shouldCapture } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify, type ClassifierVerdict } from '@/lib/ai/classify'
import { captureMemory, claimReply, releaseReply, ensureRegistered } from '@/lib/memory/write'
import { retrieve, retrieveExpanded, type RetrievedMemory } from '@/lib/memory/retrieve'
import { extractFacts } from '@/lib/ai/extract'
import { reconcileFact, currentFactsForQuery, tagMemoryAboutPerson } from '@/lib/memory/facts'
import { answer } from '@/lib/ai/reply'
import { webSearchAnswer } from '@/lib/ai/websearch'
import { expandQuery } from '@/lib/ai/expand'
import { rerank } from '@/lib/ai/rerank'
import { extractReminder } from '@/lib/ai/reminder-extract'
import { extractForget } from '@/lib/ai/forget-extract'
import { findMemoryToForget, type ForgetMode } from '@/lib/memory/forget'
import { enrichIssue, formatIssueBody } from '@/lib/ai/issue-enrich'
import { issuesConfigured, labelsFor } from '@/lib/github/issues'
import { parseReportCommand } from '@/lib/pipeline/report'
import { parseHouseReport, weeklyReport, guestReport } from '@/lib/reports/reports'
import { createPendingAction } from '@/lib/confirm/store'
import { parseWhen } from '@/lib/reminders/parse'
import { createReminder } from '@/lib/reminders/store'
import { loadRoster, memberDisplayNames } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { handleCommand } from '@/lib/identity/commands'
import { decryptSecret } from '@/lib/core/crypto'
import { loadResponsePolicy, replyAllowed } from '@/lib/policy'
import { isDirectedAtBaumy } from '@/lib/pipeline/directed'
import { sendToHouse, sendConfirmCard, getBotUsername, reactToMessage } from '@/lib/telegram/client'

// The reactive ingest pipeline (architecture D10): record-inbound → pre-filter →
// origin (real roster) → member-DM commands OR classify → write-gate → act.
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  async ({ event, step }) => {
    const { updateId, messageId, chatId, fromId, text, chatType, isBot, isForwarded, replyToBot } = event.data
    // Prefer the human name (first[+last]); fall back to @username. Backfills members
    // that were only ever seen as a raw id (so Baumy can attribute a name, not digits).
    const fromName =
      [event.data.fromFirstName, event.data.fromLastName].filter(Boolean).join(' ') || event.data.fromUsername || null
    // House group id from house_config (captured on bot-add); env override wins.
    const houseChatId = await getHouseChatId(createHttpDb())
    // Owner-configurable response policy (kill-switch / confidence floor / mutes).
    const policy = await loadResponsePolicy(createHttpDb())

    await step.run('record-inbound', async () => {
      const db = createHttpDb()
      // Idempotency record ONLY — do NOT persist the message body. `raw` is never read, and
      // the text can contain a secret (wifi/door/bank), so storing it here would keep that
      // plaintext at rest forever (the encryption layer exists precisely to avoid that).
      // update_id + chat_id are all the dedup needs.
      await db.insert(telegramUpdates).values({ updateId, chatId }).onConflictDoNothing()
      if (chatId === houseChatId) await ensureRegistered(db, chatId, fromId, fromName)
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

    // Bug/feature report (/bug, /feature, /issue, /report) → enrich into a clean GitHub
    // issue and file it on a confirm tap. Explicit slash command, works in the house group
    // OR a member DM, from an authenticated house member only. Runs before the DM-command
    // path (so /bug in a DM isn't "Unknown command") and independent of the pause switch.
    const report = parseReportCommand(text ?? '')
    if (report && fromId != null && roster.isMember(fromId)) {
      await step.run('report', async () => {
        const db = createHttpDb()
        if (!issuesConfigured()) {
          await sendToHouse(chatId, "I'd file that, but issue reporting isn't wired up yet — the house owner needs to add a GitHub token. 🐈‍⬛")
          return
        }
        if (!report.body) {
          const eg = report.hint === 'feature' ? '/feature a dark mode for the dashboard' : '/bug the reminder fired twice'
          await sendToHouse(chatId, `Tell me what to file, like:\n${eg}`)
          return
        }
        const reporter = (await memberDisplayNames(db)).get(String(fromId)) ?? 'a housemate'
        const enriched = await enrichIssue(report.body, report.hint)
        const pid = await createPendingAction(db, {
          groupId: chatId,
          actionType: 'github.issue',
          payload: { title: enriched.title, body: formatIssueBody(enriched, reporter), labels: labelsFor(enriched.type), type: enriched.type },
          requestedBy: String(fromId),
        })
        const kind = enriched.type === 'feature' ? '✨ Feature' : '🐛 Bug'
        await sendConfirmCard(chatId, `${kind}: ${enriched.title}\n\n${enriched.summary}\n\nFile this as a GitHub issue?`, pid)
      })
      return { updateId, decision: 'report' as const }
    }

    // House reports (/weekly, /guests) → post a memory-grounded report. Read-only, no
    // confirm, works in the house group OR a member DM, from a member. Independent of pause.
    const reportView = parseHouseReport(text ?? '')
    if (reportView && fromId != null && roster.isMember(fromId)) {
      await step.run('house-report', async () => {
        const db = createHttpDb()
        await reactToMessage(chatId, messageId, '👀') // seen — putting it together
        const md = reportView === 'guests' ? await guestReport(db, chatId) : await weeklyReport(db, chatId)
        await sendToHouse(chatId, md)
        await reactToMessage(chatId, messageId, null)
      })
      return { updateId, decision: 'report-view' as const }
    }

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
    // still remembered (previously it was silently forgotten). Returns whether a durable
    // FACT was learned (add/update) — that earns a 🧠 acknowledgement below.
    let learnedFact = false
    // Never capture a "forget X" request — storing "delete Madeleine Goujon" would just
    // re-add the very thing being deleted. The forget flow handles it below instead.
    if (shouldCapture(origin, verdict) && verdict.intent !== 'forget') {
      learnedFact = (await step.run('capture', async () => {
        const db = createHttpDb()
        // Never attribute quarantined (forwarded/bot) content to a housemate.
        const authoredBy = origin.memoryTrust === 'quarantined' || fromId == null ? null : String(fromId)
        // Salience from the classifier signal (no extra LLM call): durable facts matter
        // most, reminders/tasks next, questions middling, chatter least (memory v2 §5).
        const salience =
          verdict.intent === 'fact' ? 0.85 : verdict.intent === 'reminder' || verdict.intent === 'task' ? 0.7 : verdict.intent === 'question' ? 0.5 : 0.35
        const memoryItemId = await captureMemory(
          { groupId: chatId, content: text ?? '', memoryType: verdict.intent, authoredBy, trustLevel: origin.memoryTrust, salience },
          { db },
        )
        // M2: distil structured facts + trust-gated reconcile into the knowledge
        // graph. Quarantined content never writes a fact (injection wall). The
        // speaker's name lets first-person references resolve ("my room" → their room).
        let learned = false
        if (origin.memoryTrust !== 'quarantined') {
          const speaker = authoredBy ? ((await memberDisplayNames(db)).get(authoredBy) ?? null) : null
          const { facts } = await extractFacts(text ?? '', speaker)
          for (const f of facts) {
            const r = await reconcileFact(db, { groupId: chatId, fact: f, authoredBy, trustLevel: origin.memoryTrust })
            if (r === 'add' || r === 'update') learned = true
          }
          // Tag this note with the person it's about (memory v2 §3) — attributed, never scored.
          await tagMemoryAboutPerson(db, chatId, memoryItemId, facts)
        }
        return learned
      })) as boolean
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
    // A "forget X" request always gets a response (a proposal or an honest miss).
    const wantAnswer =
      canSpeak &&
      (directed || decision === 'forget' || (verdict.respond === 'answer' && replyAllowed(policy, verdict.confidence, text ?? '')))

    if (wantAnswer) {
      await step.run('reply', async () => {
        const db = createHttpDb()
        if (chatId !== houseChatId) return // belt-and-suspenders: house group only (E2)
        if (!(await claimReply(db, updateId))) return // one-send-per-inbound (D12)
        await reactToMessage(chatId, messageId, '👀') // seen — thinking
        // The claim autocommitted (neon-http) before the fallible work below (LLM/send) and
        // there is NO reply sweeper backstop — so on any error, release the claim (the
        // Inngest retry then re-claims + re-sends) and clear the stranded 👀 before rethrowing.
        try {
          await runReplyBody()
        } catch (err) {
          await releaseReply(db, updateId).catch(() => {})
          await reactToMessage(chatId, messageId, null)
          throw err
        }

        // Hoisted so the try/catch above can guard it; captures db + the message context.
        async function runReplyBody() {
        // Forget-request path: PROPOSE a deletion (nothing is deleted until a member taps
        // the confirm button — functions/callback.ts). The LLM only describes what to
        // forget; this code resolves it to concrete rows for the human to review.
        if (decision === 'forget') {
          const speaker = fromId != null ? ((await memberDisplayNames(db)).get(String(fromId)) ?? null) : null
          const ex = await extractForget(text ?? '', speaker)
          if (ex.isForget) {
            const matches = await findMemoryToForget(db, chatId, { values: ex.values, subject: ex.subject, attribute: ex.attribute })
            await reactToMessage(chatId, messageId, null)
            const mode: ForgetMode = ex.permanent ? 'purge' : 'soft'
            const aliasCount = matches.aliasHits.reduce((n, h) => n + h.remove.length, 0)
            const hasFacts = matches.facts.length > 0
            const hasScrub = matches.noteIds.length > 0 || aliasCount > 0
            // soft can only HIDE facts; purge also scrubs messages + aliases. If this mode
            // can't act on what we found, say why (or ask) rather than a misleading proposal.
            if (!hasFacts && !(mode === 'purge' && hasScrub)) {
              if (mode === 'soft' && hasScrub) {
                await sendToHouse(chatId, `That's only in past messages, not a fact I can just hide — say "permanently forget it" and I'll scrub it out for good. 😼`)
              } else if (ex.values.length === 0 && !ex.subject) {
                await sendToHouse(chatId, `What exactly should I forget? Name the specific thing — a name, number, that kind of thing 😼`)
              } else {
                await sendToHouse(chatId, `Nothing like that in my memory, so nothing to forget 😼`)
              }
              return
            }
            const pid = await createPendingAction(db, {
              groupId: chatId,
              actionType: 'memory.forget',
              payload: {
                mode,
                factIds: matches.factIds,
                scrubValues: matches.scrubValues,
                noteIds: matches.noteIds,
                aliasHits: matches.aliasHits,
                summary: ex.values.join(', ') || [ex.subject, ex.attribute].filter(Boolean).join(' ') || 'that',
              },
              requestedBy: fromId != null ? String(fromId) : null,
            })
            const lines: string[] = matches.facts.map((c) => `• ${c.label}`)
            if (mode === 'purge') {
              if (matches.noteIds.length && matches.scrubValues.length) {
                lines.push(`• scrub ${matches.scrubValues.map((v) => `"${v}"`).join(', ')} out of ${matches.noteIds.length} message${matches.noteIds.length === 1 ? '' : 's'} (keeping the rest)`)
              }
              if (aliasCount) lines.push(`• drop ${aliasCount} alias${aliasCount === 1 ? '' : 'es'}`)
            }
            const head = mode === 'purge' ? "I'll permanently forget (no undo):" : "I'll forget (hidden, reversible):"
            await sendConfirmCard(chatId, `${head}\n${lines.join('\n')}\n\nTap to confirm.`, pid)
            return
          }
          // Classifier flagged forget but it wasn't one → fall through to a normal reply.
        }
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
        // Explicit online-lookup request ("look it up", "google it") → search the web
        // (Anthropic server-side tool), blending in house memory. Fires ONLY on the
        // classifier's webSearch gate — never on a normal question — so it stays rare and
        // cost-bounded. Any failure/empty result falls through to a memory-only reply.
        // EXFIL WALL: web search is the one TOOL-enabled generation, so it must NEVER
        // receive decrypted secrets — feed it the non-secret memory only (pre-decrypt
        // `combined`, secure rows dropped), so a "google my wifi password" can't leak it.
        if (verdict.webSearch) {
          const ws = await webSearchAnswer(text ?? '', combined.filter((m) => !m.isSecure))
          if (ws.searched && ws.text) {
            await sendToHouse(chatId, ws.text)
            await reactToMessage(chatId, messageId, null) // 👀 → gone; the words are the reply
            return
          }
        }
        // Always starts on Sonnet; the model self-escalates to Opus only if it needs to.
        const { text: reply, answered } = await answer(text ?? '', grounding)
        // Graduated honest-miss: send WORDS when it answered, or when the miss is
        // itself informative (grounding was blank → "we've never mentioned that"). A bare
        // 👎 is only for an AMBIENT miss (adjacent-but-unhelpful memory) — a message that
        // @-mentions Baumy directly ALWAYS gets words, never a dismissive thumbs-down.
        if (answered || grounding.length === 0 || directed) {
          await sendToHouse(chatId, reply)
          await reactToMessage(chatId, messageId, null) // 👀 → gone; the words are the reply
        } else {
          await reactToMessage(chatId, messageId, '👎') // 👀 → 👎: ambient ask, nothing in the records
        }
        } // runReplyBody
      })
    } else if (canSpeak && reminderSet) {
      await reactToMessage(chatId, messageId, '👍') // reminder confirmed
    } else if (canSpeak && learnedFact) {
      // Learned a durable fact and no reply is warranted → make the memory VISIBLE.
      await reactToMessage(chatId, messageId, '🧠')
    } else if (canSpeak && verdict.respond === 'react') {
      await reactToMessage(chatId, messageId, verdict.reaction ?? '👍') // social vibe
    }

    return { updateId, decision, directed, respond: verdict.respond, reminderSet, source: origin.source }
  },
)
