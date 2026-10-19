import { inngest, type TelegramMessageData } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { telegramUpdates } from '@/db/schema'
import { resolveOriginParts, addressingFor } from '@/lib/core/origin'
import { prefilter } from '@/lib/pipeline/prefilter'
import { classify, type ClassifierVerdict } from '@/lib/ai/classify'
import { ensureRegistered } from '@/lib/memory/write'
import { loadRoster, memberDisplayNames } from '@/lib/identity/roster'
import { resolveHouseIds } from '@/lib/identity/house'
import { houseTz } from '@/lib/env'
import { now } from '@/lib/core/clock'
import { loadResponsePolicy } from '@/lib/policy'
import { directedness, repliesToBaumy, stripBotMention } from '@/lib/pipeline/directed'
import { getBotUsername, getBotId } from '@/lib/telegram/client'
import { buildTurnContext, type ReplyToContext } from '@/lib/turn/context'
import { runTurn } from '@/lib/turn/run'
import { runCommands } from '@/lib/turn/commands'
import { appendInbound, followsBaumyAnswer, recentTurns } from '@/lib/turn/window'
import { lookupEdit, type EditMap } from '@/lib/turn/edit'
import { admitVerifiedMember } from '@/lib/identity/verify'
import type { WindowTurn } from '@/lib/turn/context'
import type { TurnStep } from '@/lib/turn/step'

type IngestStep = TurnStep

// The reactive ingest pipeline (architecture D10, docs/spec/chat-understanding-v2.md):
//
//   intake:  record-inbound → origin (real roster) → directedness → window-append → pre-filter
//            → slash commands
//   turn:    window-read → TurnContext (deterministic) → classify (in context) → runTurn
//            (lib/turn/run.ts: the gates → actions → capture → ctx.outcome → ONE planResponse(ctx)
//            → execute: reaction | deterministic text | reply-model words)
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
    // received_at on the clock seam: the follow-up check compares it with the window's sent_at.
    await db.insert(telegramUpdates).values({ updateId, chatId, receivedAt: now() }).onConflictDoNothing()
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
  // Scope (whose shared memory), destination (where a reply may go — the two-target belt) and identity
  // (author / forwarder), produced once from the authenticated origin (lib/core/origin.ts).
  const { scope: houseScope, reply, authorId, forwarderId, windowable } = addressingFor(origin, { scopeId: houseChatId, acceptIds }, roster, messageThreadId)

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
  // A FOLLOW-UP (spec §1): Baumy's latest message here answered THIS sender a moment ago and nobody
  // spoke since — "could you also add…" needs no second @mention. Only a candidate: triage decides.
  const followsBaumy =
    lane === 'house' && !!authorId && !!houseScope && !replyToBaumy && !repliesToHuman && !isEdit
      ? ((await step.run('follow-up-check', async () => {
          try {
            return await followsBaumyAnswer(createHttpDb(), { groupId: houseScope, chatId, threadId: messageThreadId, at: now(), messageId, updateId, memberId: authorId })
          } catch (err) {
            console.warn('[baumy/ingest] follow-up check failed:', err instanceof Error ? err.message : err)
            return false
          }
        })) as boolean)
      : false
  let directed = directedness({ lane, text: rawText, botUsername, replyToBaumy, inConsoleTopic, repliesToHuman, followsBaumy })
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
  // content never grounds anything — `windowable`). A member-forwarded message is kept LABELLED as
  // forwarded (the forwarder is recorded, never as the author of those words). Secret-redacted before
  // it is stored. Best-effort: the window is context, so a failure here must not fail (and retry) the turn.
  if (windowable) {
    await step.run('window-append', async () => {
      try {
        await appendInbound(createHttpDb(), {
          groupId: houseScope,
          chatId,
          messageId,
          authorKind: origin.anonymous ? 'anon' : 'member',
          authorMemberId: forwarderId ?? authorId,
          authorName: origin.anonymous ? null : fromName,
          text,
          trust: origin.memoryTrust,
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

  // Not on the reply belt (cannot happen for a resolved lane — defensive): nothing answers anything.
  if (!reply) return { updateId, decision: 'drop' as const, reason: 'no-destination' as const }
  const cmd = await runCommands(step, { rawText, origin, roster, fromId, chatId, messageId, messageThreadId, houseScope, reply })
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
  // A follow-up stays directed only when it really asks Baumy ("thanks!" or a word to a housemate does not).
  if (directed.why === 'follow_up' && !verdict.asksBaumy) {
    directed = { value: false, why: null }
    ctx.directed = directed
  }

  // The turn: actions → ctx.outcome → ONE plan → its execution (lib/turn/run.ts).
  const { gates, plan } = await runTurn(step, ctx, { origin, policy, editMap, houseChatId, windowable, reply })

  return {
    updateId,
    decision: ctx.outcome.list ? ('list' as const) : ctx.outcome.olympics ? ('olympics' as const) : gates.decision,
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
