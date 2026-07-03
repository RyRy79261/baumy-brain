import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { resolvePendingAction } from '@/lib/confirm/store'
import { forgetMemory, type ForgetMode, type AliasHit } from '@/lib/memory/forget'
import { createIssue } from '@/lib/github/issues'
import { writeAudit } from '@/lib/audit'
import { answerCallback, editMessageText } from '@/lib/telegram/client'

// Deterministic confirm handler (security Stage D / B4). A callback_query is a
// Telegram-authenticated button press; only an ACTIVE member/owner from.id may
// resolve a pending action. The press is the injection wall — group text can
// propose a privileged action but only a human tap executes it.
export const handleCallbackQuery = inngest.createFunction(
  { id: 'handle-callback-query', retries: 2 },
  { event: 'telegram/callback.received' },
  async ({ event }) => {
    const { callbackId, fromId, chatId, messageId, data } = event.data
    const db = createHttpDb()

    // Fail closed: only an active member/owner may confirm.
    const roster = await loadRoster(db)
    if (!roster.isMember(fromId)) {
      await answerCallback(callbackId, 'Not authorized.')
      return { ignored: 'not-member' }
    }

    const [verb, id] = data.split(':')
    if ((verb !== 'c' && verb !== 'x') || !id) {
      await answerCallback(callbackId)
      return { ignored: 'bad-data' }
    }

    if (verb === 'x') {
      await resolvePendingAction(db, id, 'cancelled')
      await answerCallback(callbackId, 'Cancelled')
      if (messageId) await editMessageText(chatId, messageId, '✖️ Cancelled.')
      return { cancelled: id }
    }

    const action = await resolvePendingAction(db, id, 'confirmed')
    if (!action) {
      await answerCallback(callbackId, 'This already expired or was handled.')
      return { ignored: 'not-pending' }
    }

    // NOTE: reminders AUTO-COMMIT (they only post text to the fixed house group) — they are
    // deliberately exempt from this confirm wall, so there is no 'reminder.create' action.
    // The wall gates only genuinely privileged actions: memory.forget and github.issue.

    if (action.actionType === 'memory.forget') {
      // The TAP is the wall: the delete targets the exact fact ids + value strings resolved
      // at propose time (payload), scoped to this house, and runs only now. Facts are
      // removed; source messages are only surgically scrubbed on a purge, never deleted.
      const p = action.payload as {
        mode: ForgetMode
        factIds: string[]
        scrubValues: string[]
        noteIds: string[]
        aliasHits: AliasHit[]
        summary: string
      }
      const res = await forgetMemory(db, chatId, {
        factIds: p.factIds ?? [],
        scrubValues: p.scrubValues ?? [],
        noteIds: p.noteIds ?? [],
        aliasHits: p.aliasHits ?? [],
        mode: p.mode,
      })
      await writeAudit(db, 'memory.forget', String(fromId), p.summary ?? null, {
        mode: p.mode,
        facts: res.facts,
        messagesScrubbed: res.messagesScrubbed,
        aliasesRemoved: res.aliasesRemoved,
      })
      const verb = p.mode === 'purge' ? 'Purged' : 'Forgotten'
      const bits = [
        `${res.facts} fact${res.facts === 1 ? '' : 's'}`,
        res.messagesScrubbed ? `scrubbed ${res.messagesScrubbed} message${res.messagesScrubbed === 1 ? '' : 's'}` : '',
        res.aliasesRemoved ? `${res.aliasesRemoved} alias${res.aliasesRemoved === 1 ? '' : 'es'}` : '',
      ].filter(Boolean)
      const detail = bits.join(' + ')
      await answerCallback(callbackId, verb)
      if (messageId) await editMessageText(chatId, messageId, `${p.mode === 'purge' ? '🔥' : '🧽'} ${verb} — ${detail}.`)
      return { confirmed: id, forgot: res.facts, scrubbed: res.messagesScrubbed }
    }

    if (action.actionType === 'github.issue') {
      // File the enriched report as a GitHub issue (details resolved at propose time).
      const p = action.payload as { title: string; body: string; labels: string[]; type: string }
      const issue = await createIssue({ title: p.title, body: p.body, labels: p.labels })
      await writeAudit(db, 'github.issue', String(fromId), p.title, { type: p.type, number: issue?.number ?? null })
      if (issue) {
        await answerCallback(callbackId, 'Filed')
        if (messageId) await editMessageText(chatId, messageId, `✅ Filed #${issue.number} — ${issue.url}`)
      } else {
        await answerCallback(callbackId, "Couldn't file")
        if (messageId) await editMessageText(chatId, messageId, "⚠️ Couldn't file that — GitHub isn't set up or the API errored. Nothing was posted.")
      }
      return { confirmed: id, issue: issue?.number ?? null }
    }

    await answerCallback(callbackId, 'Done')
    return { confirmed: id, actionType: action.actionType }
  },
)
