import { inngest, type TelegramMessageData } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts } from '@/lib/core/origin'
import { decide, shouldCapture, listOpProposed } from '@/lib/core/decide'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify, type ClassifierVerdict } from '@/lib/ai/classify'
import { ensureRegistered } from '@/lib/memory/write'
import { loadRoster, memberDisplayNames } from '@/lib/identity/roster'
import { resolveHouseIds, houseScopeForOrigin } from '@/lib/identity/house'
import { houseTz } from '@/lib/env'
import { now } from '@/lib/core/clock'
import { loadResponsePolicy } from '@/lib/policy'
import { directedness, repliesToBaumy, stripBotMention } from '@/lib/pipeline/directed'
import { isSecretQuestion } from '@/lib/core/sensitivity'
import { sendToHouse, getBotUsername, getBotId } from '@/lib/telegram/client'
import { buildTurnContext } from '@/lib/turn/context'
import { planResponse } from '@/lib/turn/plan'
import { runCapture } from '@/lib/turn/capture'
import { runList, runReminder, runForget } from '@/lib/turn/actions'
import { executePlan } from '@/lib/turn/respond'
import { runCommands } from '@/lib/turn/commands'
import type { TurnStep } from '@/lib/turn/step'

type IngestStep = TurnStep

// The reactive ingest pipeline (architecture D10, docs/spec/chat-understanding-v2.md):
//
//   intake:  record-inbound → origin (real roster) → directedness → pre-filter → slash commands
//   turn:    TurnContext (deterministic) → classify (in context) → write-gate
//            → capture (evidence + facts) → actions (list / reminder / forget) → ctx.outcome
//            → ONE planResponse(ctx) → execute (reaction | deterministic text | reply-model words)
//
// The LLM proposes (triage verdict, extracted facts/items/times/targets, the words); deterministic
// code disposes (lane, trust, the write-gate, the stores, the planner, the destination belt).
// Exported as a plain function so a test can drive the WHOLE handler with a fake step and a
// synthetic event; the Inngest wrapper below only forwards its context.
export async function runIngest(event: { data: TelegramMessageData }, step: IngestStep) {
  const { updateId, messageId, chatId, fromId, chatType, isBot, isForwarded, replyToBot } = event.data
  // The message exactly as sent — commands and directedness read THIS. Everything Baumy reasons
  // over (classify / capture / retrieval / extraction / the reply) reads `text`, the @mention stripped.
  const rawText = event.data.text ?? ''
  const messageThreadId = event.data.messageThreadId ?? null
  // Prefer the human name (first[+last]); fall back to @username. Backfills members that were only
  // ever seen as a raw id (so Baumy can attribute a name, not digits).
  const fromName = [event.data.fromFirstName, event.data.fromLastName].filter(Boolean).join(' ') || event.data.fromUsername || null
  // House ids from house_config (captured on bot-add; env pins the scope). `houseChatId` is the
  // STABLE scope id (group_id everywhere); `acceptIds` also includes the live transport id so an
  // inbound message from the migrated -100… supergroup still resolves to the house lane (alias
  // seam, docs/spec/telegram.md D9). Reply destination stays the inbound chat (origin.chatId).
  const { scopeId: houseChatId, acceptIds, consoleThreadId } = await resolveHouseIds(createHttpDb())
  // Owner-configurable response policy (kill-switch / reply floor / mutes).
  const policy = await loadResponsePolicy(createHttpDb())

  await step.run('record-inbound', async () => {
    const db = createHttpDb()
    // Idempotency record ONLY — do NOT persist the message body (it can contain a secret).
    await db.insert(telegramUpdates).values({ updateId, chatId }).onConflictDoNothing()
    // Register under the stable SCOPE id (not the inbound chat). A BOT sender (GroupAnonymousBot for
    // an anonymous admin, a poll bot) is never registered as a housemate (I8).
    if (acceptIds.includes(chatId)) await ensureRegistered(db, houseChatId, isBot ? null : fromId, isBot ? null : fromName)
  })

  if (!rawText.trim()) return { updateId, decision: 'drop' as const, reason: 'empty' as const }

  // Real roster (fail-closed) + deterministic origin — before any LLM call.
  const roster = await loadRoster(createHttpDb())
  const origin = resolveOriginParts(
    { chatId, fromId, text: rawText, isPrivate: chatType === 'private', isBot, isForwarded, senderChatId: event.data.senderChatId ?? null },
    roster,
    houseChatId,
    acceptIds,
  )
  // Out of scope (a foreign group, an unknown DM sender) → nothing at all, BEFORE any branch that
  // can reply (A12).
  if (origin.lane === 'ignore') return { updateId, decision: 'drop' as const, reason: 'out-of-scope' }
  const lane = origin.lane
  // Who the words are attributed to: the authenticated sender — never for quarantined content, and
  // never the shared GroupAnonymousBot identity behind an anonymous-admin post (I8).
  const authorId = origin.memoryTrust === 'quarantined' || origin.anonymous || fromId == null ? null : String(fromId)
  // The house whose SHARED memory this message reads/writes — the SCOPE, distinct from the reply
  // DESTINATION (chatId). Derived from the authenticated lane, never text.
  const houseScope = houseScopeForOrigin(origin, houseChatId)

  // A worded house reply must echo the forum topic it was asked in; a DM has no topic.
  const houseThreadId = lane === 'house' ? (messageThreadId ?? undefined) : undefined
  const sayHouse = (body: string) => sendToHouse(chatId, body, { threadId: houseThreadId })

  // Directedness (spec §1) from Telegram-authenticated fields + Baumy's REAL @username/id (getMe).
  // A reply counts only when the replied-to author IS Baumy (C8), never the topic-root service
  // message (C9). Computed BEFORE the noise pre-filter, so "yes" answering Baumy is never dropped (C7).
  // VERBOSITY only, never trust: the text stays untrusted.
  const botUsername = await getBotUsername()
  const replyTo = event.data.replyToMessage
  const needsBotId = replyTo != null && !replyTo.isTopicRoot && replyTo.isBot
  const replyToBaumy = repliesToBaumy(replyTo, needsBotId ? await getBotId() : null, replyToBot === true)
  const inConsoleTopic = lane === 'house' && consoleThreadId != null && messageThreadId === consoleThreadId
  const repliesToHuman = !!replyTo && !replyTo.isTopicRoot && !replyTo.isBot && !replyToBaumy
  const directed = directedness({ lane, text: rawText, botUsername, replyToBaumy, inConsoleTopic, repliesToHuman })
  // What Baumy reasons over: the @mention stripped (C12) — directedness above already used it.
  const text = stripBotMention(rawText, botUsername)

  const pf = prefilter(text, { directed: directed.value, dm: lane === 'member_dm' })
  if (!pf.keep) return { updateId, decision: 'drop' as const, reason: pf.reason }

  const cmd = await runCommands(step, { rawText, origin, roster, fromId, chatId, messageId, messageThreadId, houseScope, sayHouse, houseThreadId })
  if (cmd === 'unknown-command') return { updateId, decision: 'drop' as const, reason: 'unknown-command' as const }
  if (cmd) return { updateId, decision: cmd }

  // ── The turn (spec §1) ───────────────────────────────────────────────────────────────────────
  const names = await memberDisplayNames(createHttpDb())
  const firstName = (n: string) => n.split(/\s+/)[0]
  const replyAuthor = !replyTo || replyTo.isTopicRoot ? null : replyToBaumy ? 'baumy' : replyTo.fromId != null ? (names.get(String(replyTo.fromId)) ?? 'someone') : 'someone'
  const ctx = buildTurnContext({
    updateId,
    messageId,
    chatId,
    houseScope,
    lane,
    fromId,
    senderName: authorId ? (names.get(authorId) ?? fromName) : fromName,
    isOwner: fromId != null && roster.isOwner(fromId),
    anonymous: origin.anonymous === true,
    authorId,
    trust: origin.memoryTrust,
    sentAt: now(),
    tz: houseTz(),
    threadId: messageThreadId,
    isConsole: inConsoleTopic,
    directed,
    replyTo: replyAuthor ? { author: replyAuthor, text: replyTo?.text ?? null } : null,
    text,
  })

  // Triage IN CONTEXT (memoized): lane, directed + why, console topic, who it replies to (spec §2).
  const verdict = (await step.run('classify', async () =>
    classify(text, {
      lane,
      directed,
      inConsoleTopic,
      replyTo: ctx.replyTo ? { author: ctx.replyTo.author === 'baumy' ? 'Baumy' : ctx.replyTo.author, text: ctx.replyTo.text } : null,
      from: authorId ? ctx.sender.firstName : null,
      housemates: [...new Set([...names.values()].map(firstName))].slice(0, 20),
    }),
  )) as ClassifierVerdict
  ctx.verdict = verdict
  const decision = decide(origin, verdict, directed.value)

  // Destination belt: exactly two TRANSPORT-authenticated targets — the house group, or the
  // authenticated DM sender's own chat. Never a free/LLM id (injection wall).
  const canReply =
    (lane === 'house' && acceptIds.includes(chatId)) || (lane === 'member_dm' && fromId != null && roster.isMember(fromId) && chatId === origin.chatId)
  // Pause silences the GROUP (reply AND the actions that would be acknowledged there); a DM still works.
  const canSpeak = lane === 'member_dm' || policy.global_enabled

  // Capture (evidence + facts) — orthogonal to the action, so a reminder that also states a fact is
  // still remembered. Never a question or chatter (I3), never a forget request (storing "delete X"
  // re-adds X), never a question that mentions a secret (I9).
  if (shouldCapture(origin, verdict) && decision !== 'forget' && !isSecretQuestion(text, verdict.intent)) {
    ctx.outcome.captured = await runCapture(step, ctx)
  }

  // Actions → ctx.outcome. Each auto-commits (list, reminder) or only proposes (forget).
  if (houseScope && canReply && listOpProposed(origin, verdict.list, policy.global_enabled, verdict.intent)) {
    ctx.outcome.list = await runList(step, ctx)
  }
  // Reminders honour pause in BOTH lanes (they post to the house group) — unchanged from pre-v2.
  if (decision === 'reminder' && policy.global_enabled) {
    ctx.outcome.reminder = await runReminder(step, ctx, houseChatId)
  }
  if (decision === 'forget' && canSpeak && canReply) {
    ctx.outcome.forget = await runForget(step, ctx)
  }

  // ONE decision about Baumy's voice, from what the turn is and what actually happened (spec §3).
  const plan = planResponse(ctx, policy)
  await executePlan(step, ctx, plan, { canReply })

  return {
    updateId,
    decision: ctx.outcome.list ? ('list' as const) : decision,
    directed: directed.value,
    directedWhy: directed.why,
    plan: plan.kind === 'words' ? `words:${plan.mode}` : plan.kind,
    planRow: plan.row,
    reminderSet: ctx.outcome.reminder?.status === 'set',
    source: origin.source,
  }
}

export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3 },
  { event: 'telegram/message.received' },
  ({ event, step }) => runIngest(event, step as unknown as IngestStep),
)
