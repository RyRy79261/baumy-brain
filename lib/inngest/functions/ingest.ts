import { inngest, type TelegramMessageData } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts, isRelayed } from '@/lib/core/origin'
import { decide, shouldCapture, listOpProposed, reminderFollowUpAllowed, olympicsOpProposed } from '@/lib/core/decide'
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
import { buildTurnContext, type ReplyToContext } from '@/lib/turn/context'
import { planResponse } from '@/lib/turn/plan'
import { runCapture } from '@/lib/turn/capture'
import { runList, runReminder, runForget, runCancelReminder, runOlympics, primaryReminder } from '@/lib/turn/actions'
import { takeReminderDraft } from '@/lib/reminders/draft'
import { executePlan } from '@/lib/turn/respond'
import { runCommands } from '@/lib/turn/commands'
import { appendInbound, recentTurns, linkProduced, withholdTurn } from '@/lib/turn/window'
import { lookupEdit, withdrawForEdit, settleEditedFacts, type EditMap } from '@/lib/turn/edit'
import { admitVerifiedMember } from '@/lib/identity/verify'
import type { WindowTurn } from '@/lib/turn/context'
import type { TurnStep } from '@/lib/turn/step'

type IngestStep = TurnStep

// The reactive ingest pipeline (architecture D10, docs/spec/chat-understanding-v2.md):
//
//   intake:  record-inbound → origin (real roster) → directedness → window-append → pre-filter
//            → slash commands
//   turn:    window-read → TurnContext (deterministic) → classify (in context) → write-gate
//            → capture (evidence + facts) → actions (list / reminder / forget / cancel-reminder) → ctx.outcome
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
  const { scopeId: houseChatId, sendId: houseSendId, acceptIds, consoleThreadId } = await resolveHouseIds(createHttpDb())
  const isEdit = event.data.isEdit === true
  // Owner-configurable response policy (kill-switch / reply floor / mutes).
  const policy = await loadResponsePolicy(createHttpDb())

  await step.run('record-inbound', async () => {
    const db = createHttpDb()
    // Idempotency record ONLY — the ledger never holds the message body. (The text lives only in the
    // 48h conversation window, secret-redacted — window-append below, spec §5.)
    await db.insert(telegramUpdates).values({ updateId, chatId }).onConflictDoNothing()
    // Register under the stable SCOPE id (not the inbound chat). A BOT sender (GroupAnonymousBot for
    // an anonymous admin, a poll bot) is never registered as a housemate (I8).
    if (acceptIds.includes(chatId)) await ensureRegistered(db, houseChatId, isBot ? null : fromId, isBot ? null : fromName)
  })

  // No text and no caption (I4): a voice note, sticker, location… is ignored EXPLICITLY — the media
  // is never fetched or interpreted (lib/telegram/content.ts). A caption arrives folded into `text`.
  if (!rawText.trim()) return { updateId, decision: 'drop' as const, reason: event.data.media ? ('media' as const) : ('empty' as const) }

  // Real roster (fail-closed) + deterministic origin — before any LLM call.
  let roster = await loadRoster(createHttpDb())
  // A housemate Baumy has never seen speak in the group (K6): an unknown PRIVATE sender is checked
  // against Telegram's membership of the house group (getChatMember — fail-closed, a "no" cached). An
  // active member is added to the roster and served; anyone else stays out of scope. Memoized: a retry
  // never re-asks, and the roster is re-read after the upsert.
  if (chatType === 'private' && fromId != null && !isBot && houseChatId && !roster.isMember(fromId)) {
    const admitted = (await step.run('verify-member', () =>
      admitVerifiedMember(createHttpDb(), { scopeId: houseChatId, sendId: houseSendId }, fromId, fromName),
    )) as boolean
    if (admitted) roster = await loadRoster(createHttpDb())
  }
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
  // Who the words are attributed to: the authenticated sender — never for relayed content (a forwarded
  // message is someone else's words; a bot post is nobody's), and never the shared GroupAnonymousBot
  // identity behind an anonymous-admin post (I8).
  const authorId = isRelayed(origin.memoryTrust) || origin.anonymous || fromId == null ? null : String(fromId)
  // A member-FORWARDED message (D4): who relayed it — recorded beside the note, never as its author.
  const forwarderId = origin.memoryTrust === 'forwarded' && !origin.anonymous && fromId != null ? String(fromId) : null
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

  // An EDIT (I1): what did the original produce? Read BEFORE the window upsert below — the row's mere
  // existence is how we know Baumy processed the original (lib/turn/edit.ts).
  const editMap: EditMap | null =
    isEdit && houseScope
      ? ((await step.run('edit-lookup', () => lookupEdit(createHttpDb(), { chatId, messageId }))) as EditMap)
      : null

  // The 48h conversation window (spec §5): every in-scope message, BEFORE the noise filter (an "ok"
  // or "lol" is still part of the conversation) — but never another bot's post (quarantined bot
  // content never grounds anything). A member-forwarded message is kept LABELLED as forwarded (the
  // forwarder is recorded, never as the author of those words). Secret-redacted before it is stored.
  // Best-effort: the window is context, so a failure here must not fail (and retry) the whole turn.
  const botContent = isBot === true && !origin.anonymous
  if (houseScope && !botContent) {
    await step.run('window-append', async () => {
      try {
        const forwarded = isForwarded === true
        await appendInbound(createHttpDb(), {
          groupId: houseScope,
          chatId,
          messageId,
          authorKind: origin.anonymous ? 'anon' : 'member',
          authorMemberId: forwarded ? (fromId != null ? String(fromId) : null) : authorId,
          authorName: origin.anonymous ? null : fromName,
          text,
          trust: forwarded ? 'forwarded' : origin.memoryTrust,
          replyToMessageId: replyTo && !replyTo.isTopicRoot ? (replyTo.messageId ?? null) : null,
          threadId: lane === 'house' ? messageThreadId : null,
          sentAt: now(),
        })
      } catch (err) {
        console.warn('[baumy/ingest] conversation-window append failed:', err instanceof Error ? err.message : err)
      }
    })
  }

  const pf = prefilter(text, { directed: directed.value, dm: lane === 'member_dm' })
  if (!pf.keep) return { updateId, decision: 'drop' as const, reason: pf.reason }

  // An edited slash command is not run again (a second /weekly post, a re-pointed topic): commands act
  // once, on the message as first sent.
  if (isEdit && rawText.trim().startsWith('/')) return { updateId, decision: 'drop' as const, reason: 'edited-command' as const }

  const cmd = await runCommands(step, { rawText, origin, roster, fromId, chatId, messageId, messageThreadId, houseScope, sayHouse, houseThreadId })
  if (cmd === 'unknown-command') return { updateId, decision: 'drop' as const, reason: 'unknown-command' as const }
  if (cmd) return { updateId, decision: cmd }

  // ── The turn (spec §1) ───────────────────────────────────────────────────────────────────────
  const names = await memberDisplayNames(createHttpDb())
  // The last turns of THIS chat (and topic) within 48h, Baumy's own replies included — memoized, so
  // triage and the reply (a later step) read the same conversation. Excludes this message itself.
  const sentAt = now()
  const recent = houseScope
    ? (
        (await step.run('window-read', async () => {
          try {
            return await recentTurns(createHttpDb(), {
              groupId: houseScope,
              chatId,
              threadId: lane === 'house' ? messageThreadId : null,
              at: sentAt,
              excludeMessageId: messageId,
            })
          } catch (err) {
            // Context only: without it the turn still runs (as it did before the window existed).
            console.warn('[baumy/ingest] conversation-window read failed:', err instanceof Error ? err.message : err)
            return []
          }
        })) as (Omit<WindowTurn, 'at'> & { at: string | Date })[]
      ).map((t) => ({ ...t, at: new Date(t.at) }))
    : []
  const firstName = (n: string) => n.split(/\s+/)[0]
  // The replied-to message, as the models may be told it (ReplyToContext). Its TEXT only when the
  // author is Baumy or a roster housemate in their own words: another bot's post or a forwarded
  // message is quarantined content — it must never ground a reply, nor read as the forwarder's words.
  const replyCtx = ((): ReplyToContext | null => {
    if (!replyTo || replyTo.isTopicRoot) return null
    if (replyToBaumy) return { author: 'baumy', text: replyTo.text }
    const name = replyTo.fromId != null ? (names.get(String(replyTo.fromId)) ?? null) : null
    if (replyTo.isBot) return { author: 'another bot', text: null, withheld: 'bot' }
    if (replyTo.isForwarded) return { author: name ?? 'someone', text: null, withheld: 'forwarded' }
    if (replyTo.fromId == null || !roster.isMember(replyTo.fromId)) return { author: 'someone', text: null, withheld: 'not_a_housemate' }
    return { author: name ?? 'a housemate', text: replyTo.text }
  })()
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
    forwardedBy: forwarderId ? { id: forwarderId, name: names.get(forwarderId) ?? fromName ?? 'a housemate' } : null,
    edit: isEdit ? { processed: editMap?.processed === true } : null,
    trust: origin.memoryTrust,
    sentAt,
    tz: houseTz(),
    threadId: messageThreadId,
    isConsole: inConsoleTopic,
    directed,
    replyTo: replyCtx,
    text,
    recent,
  })

  // Triage IN CONTEXT (memoized): lane, directed + why, console topic, who it replies to (spec §2).
  const verdict = (await step.run('classify', async () =>
    classify(text, {
      lane,
      directed,
      inConsoleTopic,
      replyTo: ctx.replyTo,
      from: authorId ? ctx.sender.firstName : null,
      forwardedBy: ctx.forwardedBy ? ctx.forwardedBy.name.split(/\s+/)[0] : origin.memoryTrust === 'forwarded' ? '' : null,
      housemates: [...new Set([...names.values()].map(firstName))].slice(0, 20),
      recent: { turns: recent, tz: ctx.tz, now: sentAt },
    }),
  )) as ClassifierVerdict
  ctx.verdict = verdict
  const decision = decide(origin, verdict, directed.value)
  // A forget request is never captured (storing "delete X" re-adds X) — nor kept verbatim in the
  // conversation window: only that something was asked to be forgotten. Keyed on the classifier's
  // INTENT, not the decision: a forget-looking message below the confidence bar (or in a lane that may
  // not propose one) is still "forget my number 0176…" and must not be quoted back for 48h.
  if (verdict.intent === 'forget' && houseScope && !botContent) {
    await step.run('window-withhold', () => withholdTurn(createHttpDb(), { chatId, messageId }, '[asked Baumy to forget something — withheld]'))
  }

  // Destination belt: exactly two TRANSPORT-authenticated targets — the house group, or the
  // authenticated DM sender's own chat. Never a free/LLM id (injection wall).
  const canReply =
    (lane === 'house' && acceptIds.includes(chatId)) || (lane === 'member_dm' && fromId != null && roster.isMember(fromId) && chatId === origin.chatId)
  // Pause silences the GROUP (reply AND the actions that would be acknowledged there); a DM still works.
  const canSpeak = lane === 'member_dm' || policy.global_enabled

  // An edit of a processed message: withdraw what the original produced BEFORE the edited text is
  // re-read — its note (so consolidation cannot fold the edit back onto it) and its unsent reminders
  // (the edit re-creates whatever it still asks for). Facts are settled after capture (lib/turn/edit.ts).
  // While the house is PAUSED the edited text cannot re-create a reminder (reminders honour /pause in
  // both lanes), so the original's are left alone — cancelling them would silently delete the reminder,
  // and nobody is told (the planner is quiet for an edit and for a paused house).
  const keepRemindersForEdit = !policy.global_enabled
  if (editMap?.processed) {
    await step.run('edit-withdraw', () => withdrawForEdit(createHttpDb(), houseScope, keepRemindersForEdit ? { ...editMap, reminderIds: [] } : editMap))
  }

  // Actions → ctx.outcome. The shopping list first: a message handled as a list op is NOT also captured
  // as a memory note (A11) — "we're out of milk" lives in the list table, where "got the milk" ticks it
  // off; as a note it stayed "we're out of milk" in memory forever. The list auto-commits
  // (capture tier); reminder / forget below.
  if (houseScope && canReply && listOpProposed(origin, verdict.list, policy.global_enabled, verdict.intent)) {
    ctx.outcome.list = await runList(step, ctx)
  }

  // Baumy Olympics (docs/spec/olympics.md): the house calendar and the chore game, AS the sender. A
  // directed ask from an authenticated housemate only (olympicsOpProposed); reads answer straight away,
  // a write is only a confirm card until the asker taps it. Like a list op it is not also captured as
  // a memory note — the calendar / the chore log is where it lives. Not on an edit (it never speaks).
  if (houseScope && canReply && !isEdit && !ctx.outcome.list && olympicsOpProposed(origin, verdict, directed.value, authorId, policy.global_enabled)) {
    ctx.outcome.olympics = await runOlympics(step, ctx)
  }

  // Reminders honour pause in BOTH lanes (they post to the house group) — unchanged from pre-v2 —
  // but a paused one is an explicit outcome, so a DM ask hears WHY nothing was scheduled.
  // A directed message may also complete an earlier reminder still waiting for its time (the answer
  // to Baumy's clarifying question): the open draft is taken one-shot and handed to the extractor.
  if (policy.global_enabled) {
    const draft =
      houseScope && authorId && reminderFollowUpAllowed(origin, verdict, directed.value, authorId)
        ? ((await step.run('reminder-draft', () => takeReminderDraft(createHttpDb(), { groupId: houseScope, chatId, requestedBy: authorId }))) as {
            content: string
          } | null)
        : null
    if (decision === 'reminder' || draft) {
      const all = await runReminder(step, ctx, houseChatId, draft)
      if (all) {
        ctx.outcome.reminders = all
        ctx.outcome.reminder = primaryReminder(all)
      }
    }
  } else if (decision === 'reminder') {
    ctx.outcome.reminder = { status: 'paused' }
  }
  // A reminder asked for in a member's own DM is PRIVATE (D2): delivered to that DM, never listed in the
  // group — so its words are not written into shared house memory either ("remind me before my doctor's
  // appointment Fri 3pm" must not become a house fact, a /weekly event and a heads-up in the group). Only
  // when the reminder step set one for the HOUSE is the message house business. (Reminders run first so
  // this is known; while paused none is set, and a DM ask is personal by default — reminderIsPersonal.)
  const privateDmReminder =
    lane === 'member_dm' &&
    (decision === 'reminder' || verdict.intent === 'reminder') &&
    !(ctx.outcome.reminders ?? []).some((r) => r.status === 'set' && r.deliverTo === 'house')

  // Capture (evidence + facts) — orthogonal to the action, so a reminder that also states a fact is
  // still remembered. Never a question or chatter (I3), never a forget request (storing "delete X"
  // re-adds X), never a question that mentions a secret (I9), never a list op (A11), never a private
  // DM reminder (D2, above).
  if (!ctx.outcome.list && !ctx.outcome.olympics && !privateDmReminder && shouldCapture(origin, verdict) && decision !== 'forget' && !isSecretQuestion(text, verdict.intent)) {
    ctx.outcome.captured = await runCapture(step, ctx)
    // The window-append redacted on the raw text; the fact layer scans the extracted TRIPLE, which
    // catches more ("wifi is hunter2 now" → wifi · has_password · hunter2 is secure, the sentence is
    // not). A secret the turn has detected is never persisted (spec §5): keep only its descriptor.
    const secure = ctx.outcome.captured.secure
    if (secure && houseScope && !botContent) {
      await step.run('window-withhold-secret', () => withholdTurn(createHttpDb(), { chatId, messageId }, `[a message containing ${secure} — withheld]`))
    }
  }

  if (editMap?.processed) {
    const captured = ctx.outcome.captured
    await step.run('edit-settle', () =>
      settleEditedFacts(createHttpDb(), houseScope, editMap, {
        produced: captured?.factIds ?? [],
        kept: captured?.keptFactIds ?? [],
        noteId: captured?.memoryItemId ?? null,
      }),
    )
  }

  // Forget only PROPOSES (a confirm card) — pointless for an edit, which never speaks: re-ask instead.
  if (decision === 'forget' && canSpeak && canReply && !isEdit) {
    ctx.outcome.forget = await runForget(step, ctx)
  }

  // Cancelling a reminder only PROPOSES (a confirm card listing exactly what would go — the tap cancels,
  // functions/callback.ts). Like forget: not on an edit (it never speaks), not into a paused group.
  if (decision === 'cancel_reminder' && houseScope && canSpeak && canReply && !isEdit) {
    ctx.outcome.cancelReminder = await runCancelReminder(step, ctx)
  }

  // What this message produced, on its window row — the map an edit needs to supersede it (I1). An edit
  // always rewrites it (what the original produced has just been withdrawn or settled).
  const reminderIds = [
    ...(ctx.outcome.reminders ?? []).flatMap((r) => (r.status === 'set' && r.id ? [r.id] : [])),
    // A paused edit kept the original's reminders — they are still this message's (a later edit finds them).
    ...(editMap?.processed && keepRemindersForEdit ? editMap.reminderIds : []),
  ]
  if (houseScope && (ctx.outcome.captured || reminderIds.length || isEdit)) {
    await step.run('window-link', async () => {
      try {
        await linkProduced(
          createHttpDb(),
          { chatId, messageId },
          {
            memoryItemId: ctx.outcome.captured?.memoryItemId,
            // An edit that restated the original's own facts still "produced" them — a second edit must
            // find them. (Never another message's fact a turn merely repeated: editing that away must not
            // retract what someone else said.)
            factIds: [
              ...(ctx.outcome.captured?.factIds ?? []),
              ...(ctx.outcome.captured?.keptFactIds ?? []).filter((id) => editMap?.factIds.includes(id)),
            ],
            reminderIds,
          },
        )
      } catch (err) {
        console.warn('[baumy/ingest] conversation-window link failed:', err instanceof Error ? err.message : err)
      }
    })
  }

  // ONE decision about Baumy's voice, from what the turn is and what actually happened (spec §3).
  const plan = planResponse(ctx, policy)
  await executePlan(step, ctx, plan, { canReply })

  return {
    updateId,
    decision: ctx.outcome.list ? ('list' as const) : ctx.outcome.olympics ? ('olympics' as const) : decision,
    directed: directed.value,
    directedWhy: directed.why,
    plan: plan.kind === 'words' ? `words:${plan.mode}` : plan.kind,
    planRow: plan.row,
    reminderSet: ctx.outcome.reminder?.status === 'set',
    source: origin.source,
  }
}

// Per-chat ORDERED ingest (spec §7, F16): one run at a time per chat, so "Zosia arrives Friday" and a
// "sorry, Saturday" seconds later are reconciled in the order they were said — without it, whichever
// run finished last won, and a correction could be superseded by the message it corrected. Keyed on the
// inbound chat (the house group, or one member's DM); different chats still run in parallel.
export const handleTelegramMessage = inngest.createFunction(
  { id: 'handle-telegram-message', retries: 3, concurrency: [{ key: 'event.data.chatId', limit: 1 }] },
  { event: 'telegram/message.received' },
  ({ event, step }) => runIngest(event, step as unknown as IngestStep),
)
