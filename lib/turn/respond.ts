import { createHttpDb } from '@/db/client'
import { claimReply, releaseReply } from '@/lib/memory/write'
import { answer } from '@/lib/ai/reply'
import { webSearchAnswer } from '@/lib/ai/websearch'
import { addAck, checkoffAck, renderList } from '@/lib/lists/format'
import { sendToHouse, sendConfirmCard, reactToMessage } from '@/lib/telegram/client'
import { gatherGrounding } from './grounding'
import { forgetExplanation } from './actions'
import type { Plan } from './plan'
import { fmtWhen, type TurnContext, type TurnOutcome } from './context'
import { describeRecurrence } from '@/lib/reminders/recurrence'
import type { TurnStep } from './step'

// Carry out the planner's decision (lib/turn/plan.ts). The planner chose the SHAPE; this sends it:
// a reaction, the deterministic list / forget text, or the reply model's words in the chosen MODE.
//
// Every worded send goes through the claim-and-release belt (claimReply keyed on update_id, D12):
// exactly one send per inbound message, and on any error the claim is released (and a stranded 👀
// cleared) before rethrowing so the Inngest retry re-claims and re-sends. There is no reply sweeper
// backstop, so the release is what makes a failed send retry-safe.

export interface RespondDeps {
  /** The destination belt passed: the house group, or the authenticated sender's own DM. */
  canReply: boolean
}

export async function executePlan(step: TurnStep, ctx: TurnContext, plan: Plan, deps: RespondDeps): Promise<void> {
  if (plan.kind === 'none') return
  // Reactions are idempotent and cosmetic — no claim needed.
  if (plan.kind === 'react') {
    await reactToMessage(ctx.chatId, ctx.messageId, plan.emoji)
    return
  }
  // Destination allow-list: exactly two TRANSPORT-authenticated targets — the house group, or the
  // message sender's OWN private chat. Never a free/LLM-supplied id (injection wall).
  if (!deps.canReply) return

  // In a forum supergroup a worded reply must echo the topic it was asked in (else Telegram drops it
  // into General); a DM has no topic. Words are sent as a Telegram REPLY to the message (C11).
  const threadId = ctx.lane === 'house' ? (ctx.topic.threadId ?? undefined) : undefined
  const say = (text: string, windowText?: string) => sendToHouse(ctx.chatId, text, { threadId, replyToMessageId: ctx.messageId, windowText })

  const once = async (id: string, body: (db: ReturnType<typeof createHttpDb>) => Promise<void>, onError?: () => Promise<void>) =>
    step.run(id, async () => {
      const db = createHttpDb()
      if (!(await claimReply(db, ctx.updateId))) return // one-send-per-inbound (D12)
      try {
        await body(db)
      } catch (err) {
        await releaseReply(db, ctx.updateId).catch(() => {})
        await onError?.()
        throw err
      }
    })

  if (plan.kind === 'list-words') {
    const l = ctx.outcome.list
    if (!l) return
    await once('list-send', async () => {
      await say(l.op === 'query' ? renderList(l.open) : l.op === 'add' ? addAck(l.added, l.already, l.open.length) : checkoffAck(l.checkedOff, l.notFound, l.open))
    })
    return
  }

  if (plan.kind === 'forward-ack') {
    await once('forward-ack', async () => {
      await say(forwardAck(ctx.outcome.captured != null))
    })
    return
  }

  if (plan.kind === 'forget') {
    const f = ctx.outcome.forget
    if (!f) return
    await once('forget-send', async () => {
      // The card names what would be forgotten — the conversation window keeps only that one was asked.
      if (f.proposed) await sendConfirmCard(ctx.chatId, f.card, f.pendingId, threadId, ctx.messageId, FORGET_CARD_WINDOW_TEXT)
      else if (f.reason !== 'not_forget') await say(forgetExplanation(f.reason))
    })
    return
  }

  if (plan.kind === 'olympics') {
    const ol = ctx.outcome.olympics
    if (!ol) return
    // The same message may also have asked for reminders (a calendar add + "remind the group the day
    // before"): one send per inbound, so what they did rides on the card / line, deterministically.
    const also = reminderLines(ctx.outcome, ctx.tz)
    await once('olympics-send', async () => {
      if (ol.proposed) await sendConfirmCard(ctx.chatId, [ol.card, ...also].join('\n\n'), ol.pendingId, threadId, ctx.messageId)
      else await say([ol.text, ...also].join('\n\n'))
    })
    return
  }

  if (plan.kind === 'cancel-reminder') {
    const c = ctx.outcome.cancelReminder
    if (!c?.proposed) return
    await once('cancel-reminder-send', async () => {
      await sendConfirmCard(ctx.chatId, c.card, c.pendingId, threadId, ctx.messageId)
    })
    return
  }

  // Words from the reply model. 👀 while it thinks, swapped for the words (or a 👎 on an ambient miss).
  const clear = () => reactToMessage(ctx.chatId, ctx.messageId, null)
  await once(
    'reply',
    async (db) => {
      await reactToMessage(ctx.chatId, ctx.messageId, '👀') // seen — thinking
      const v = ctx.verdict
      // Deep (broad history search) only for a real question.
      const deep = plan.mode === 'answer' && v?.intent === 'question' && v.tier === 'deep'
      const grounding = await gatherGrounding(db, ctx, { deep, mode: plan.mode })
      // Explicit online-lookup request ("look it up", "google it") → search the web (Anthropic
      // server-side tool), blending in house memory. Fires ONLY on the classifier's webSearch gate.
      // EXFIL WALL: web search is the one TOOL-enabled generation, so it only ever gets the
      // NON-secret memory (never decrypted) — a "google my wifi password" can't leak it.
      if (plan.mode === 'answer' && v?.webSearch) {
        const ws = await webSearchAnswer(ctx.text, grounding.forWeb)
        if (ws.searched && ws.text) {
          await say(ws.text)
          await (plan.alsoReact ? reactToMessage(ctx.chatId, ctx.messageId, plan.alsoReact) : clear())
          return
        }
      }
      // Always starts on Sonnet; the model self-escalates to Opus only if it needs to.
      const { text, answered } = await answer(ctx, plan.mode, grounding.items)
      if (!answered && plan.onMiss === '👎') {
        // An ambient (unaddressed) ask the records can't answer: a quiet 👎, never a line of
        // "no idea" into the group. A directed ask or a DM always gets words.
        await reactToMessage(ctx.chatId, ctx.messageId, '👎')
        return
      }
      // An answer that disclosed a secure value may carry it in words no pattern recognises ("it's
      // hunter2") — the conversation window stores a placeholder, never the value (spec §5). The same
      // for Baumy's words on a turn that STORED a secret: the ack of "wifi is hunter2 now" may echo it.
      const secureNoted = ctx.outcome.captured?.secure
      await say(
        text,
        grounding.disclosed.length
          ? `[Baumy's answer — it gave ${grounding.disclosed.join(', ')}; withheld]`
          : secureNoted
            ? `[Baumy's reply about ${secureNoted} — withheld]`
            : undefined,
      )
      await (plan.alsoReact ? reactToMessage(ctx.chatId, ctx.messageId, plan.alsoReact) : clear())
    },
    clear,
  )
}

/** The deterministic DM line for a message a member forwarded to Baumy (D4). Never the reply model:
 *  a forwarded message is someone else's words, and answering it would treat them as the member's. */
export function forwardAck(kept: boolean): string {
  return kept
    ? "Got it — filed that for the house as something you forwarded (not your own words). Ask me about it any time 📎"
    : "Read it — nothing in there I need to keep for the house 😼"
}

/** What the conversation window keeps of a forget confirm card (the card itself names the target). */
export const FORGET_CARD_WINDOW_TEXT = '[a confirm card for forgetting something — details withheld]'

/** What the turn's reminders did, as deterministic lines — for a send that is not the reply model's
 *  (an Olympics card): a set one with its resolved day + time, a failed one with why and what to say. */
export function reminderLines(o: TurnOutcome, tz: string): string[] {
  return (o.reminders ?? (o.reminder ? [o.reminder] : [])).map((r) => {
    if (r.status === 'set') {
      const repeat = describeRecurrence(r.recurrence)
      return `⏰ Reminder set: ${fmtWhen(r.fireAt, tz)}${repeat ? ` (repeats ${repeat})` : ''} — ${r.content}`
    }
    if (r.status === 'paused') return "⏸️ No reminder set — I'm paused in the house group."
    if (r.status === 'past') return `⚠️ No reminder set — that time is already past (${r.content}). Tell me a new time.`
    return `⚠️ No reminder set — I couldn't work out when (${r.content}). Tell me a time.`
  })
}
