import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { resolveHouseIds } from '@/lib/identity/house'
import { resolvePendingAction, pendingForSomeoneElse, reopenPendingAction } from '@/lib/confirm/store'
import { forgetMemory, type ForgetMode, type AliasHit } from '@/lib/memory/forget'
import { cancelRemindersOnTap } from '@/lib/reminders/cancel'
import { createIssue } from '@/lib/github/issues'
import { writeAudit } from '@/lib/audit'
import { answerCallback, editMessageText } from '@/lib/telegram/client'
import { callOlympicsAction, type OlympicsResult } from '@/lib/olympics/client'
import { tapResultLine, type OlympicsPending } from '@/lib/olympics/intents'
import { LOGIN_ACTION_TYPE, loginCardChoices, loginResultLine, parseLoginTap, type LoginPending } from '@/lib/olympics/login-approval'

// Deterministic confirm handler (security Stage D / B4). A callback_query is a
// Telegram-authenticated button press; only an ACTIVE member/owner from.id may
// resolve a pending action. The press is the injection wall — group text can
// propose a privileged action but only a human tap executes it.
//
// Exported as a plain function (like runIngest) so the sandbox can drive a real TAP — the second half
// of the confirm wall — through the same code; the Inngest wrapper below only forwards its context.
export interface CallbackData {
  callbackId: string
  fromId: number
  chatId: string
  messageId?: number | null
  data: string
}
type CallbackStep = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }

export async function runCallback(event: { data: CallbackData }, step: CallbackStep) {
  const { callbackId, fromId, chatId, messageId, data } = event.data
  const db = createHttpDb()

  // Fail closed: only an active member/owner may confirm.
  const roster = await loadRoster(db)
  if (!roster.isMember(fromId)) {
    await answerCallback(callbackId, 'Not authorized.')
    return { ignored: 'not-member' }
  }

  const [verb, id] = data.split(':')
  if ((verb !== 'c' && verb !== 'x' && verb !== 'l') || !id) {
    await answerCallback(callbackId)
    return { ignored: 'bad-data' }
  }

  const tapper = String(fromId)
  // A card that acts AS its asker (a Baumy Olympics write) is theirs alone to confirm or cancel.
  const notYours = async () => {
    const other = await pendingForSomeoneElse(db, id, tapper)
    if (other) await answerCallback(callbackId, 'Only the person who asked can confirm this one.')
    return other != null
  }

  // A number on a Sign in with Baumy card (`l:<id>:<n>`): Olympics decides whether it is the one
  // on the screen. Only the member the card was sent to resolves it (REQUESTER_ONLY_ACTIONS).
  if (verb === 'l') {
    const t = parseLoginTap(data)
    const choices = t ? await step.run('login-card', () => loginCardChoices(db, t.actionId)) : null
    if (!t || (choices && !choices.includes(t.code))) {
      await answerCallback(callbackId)
      return { ignored: 'bad-data' }
    }
    const action = await step.run('login-resolve', () => resolvePendingAction(db, t.actionId, 'confirmed', tapper))
    if (!action && (await notYours())) return { ignored: 'not-requester' }
    if (!action || action.actionType !== LOGIN_ACTION_TYPE) {
      await answerCallback(callbackId, 'This already expired or was handled.')
      return { ignored: 'not-pending' }
    }
    const p = action.payload as unknown as LoginPending
    return runLoginTap({ id: t.actionId, p, name: 'approve_login', input: { requestId: p.requestId, code: t.code } })
  }

  async function runLoginTap(o: { id: string; p: LoginPending; name: 'approve_login' | 'deny_login'; input: Record<string, unknown> }) {
    // One key per answer: a retried tap resends it; a different number after a reopen is a new call.
    const key = `login-${o.id}-${'code' in o.input ? String(o.input.code) : 'deny'}`
    const result = (await step.run('olympics-login-call', () =>
      callOlympicsAction<{ outcome?: string }>(o.name, o.input, { actor: tapper, idempotencyKey: key, confirmed: true }),
    )) as OlympicsResult<{ outcome?: string }>
    if (!result.ok && result.kind === 'unavailable') {
      const reopened = await step.run('olympics-login-reopen', () => reopenPendingAction(db, o.id))
      await answerCallback(callbackId, reopened ? "Olympics didn't answer — tap again in a moment." : "Olympics didn't answer, and this sign-in has expired.")
      if (!reopened && messageId) await editMessageText(chatId, messageId, '⚠️ Not done — Olympics didn\'t answer and the sign-in expired.')
      return { login: o.name, olympics: 'unavailable', reopened }
    }
    await step.run('olympics-login-audit', () =>
      writeAudit(db, 'olympics.login', tapper, o.p.device, {
        action: o.name,
        requestId: o.p.requestId,
        ok: result.ok,
        ...(result.ok ? { outcome: result.data?.outcome ?? null } : { kind: result.kind, code: result.kind === 'refused' ? result.code : null }),
      }),
    )
    await answerCallback(callbackId, result.ok ? 'Done' : 'Not done')
    if (messageId) await editMessageText(chatId, messageId, loginResultLine(o.p, result))
    return { login: o.name, olympics: result.ok ? (result.data?.outcome ?? 'ok') : result.kind }
  }

  if (verb === 'x') {
    const dropped = await step.run('cancel', () => resolvePendingAction(db, id, 'cancelled', tapper))
    if (!dropped && (await notYours())) return { ignored: 'not-requester' }
    // Deny on a Sign in with Baumy card: tell Olympics, so the waiting screen hears it at once.
    if (dropped?.actionType === LOGIN_ACTION_TYPE) {
      const p = dropped.payload as unknown as LoginPending
      return runLoginTap({ id, p, name: 'deny_login', input: { requestId: p.requestId } })
    }
    // On a reminder-cancellation card "Cancelled" would read as "the reminder was cancelled" — the
    // opposite of what the tap did. Say what happened: the reminder is kept.
    const keep = dropped?.actionType === 'reminder.cancel'
    await answerCallback(callbackId, keep ? 'Kept' : 'Cancelled')
    if (messageId) await editMessageText(chatId, messageId, keep ? '✖️ Kept — no reminder was cancelled.' : '✖️ Cancelled.')
    return { cancelled: id }
  }

  // Resolve in its OWN step so the result is MEMOIZED: a retry after a downstream effect
  // fails replays the action here WITHOUT re-flipping the row, so the effect can safely
  // re-run instead of being silently lost to "already handled".
  const action = await step.run('resolve', () => resolvePendingAction(db, id, 'confirmed', tapper))
  if (!action && (await notYours())) return { ignored: 'not-requester' }
  if (!action) {
    await answerCallback(callbackId, 'This already expired or was handled.')
    return { ignored: 'not-pending' }
  }
  // A sign-in card has no Confirm button; only its numbers (verb `l`) and Deny resolve it.
  if (action.actionType === LOGIN_ACTION_TYPE) {
    await answerCallback(callbackId)
    return { ignored: 'bad-data' }
  }

  // NOTE: reminders AUTO-COMMIT (they only post text to the fixed house group) — they are
  // deliberately exempt from this confirm wall, so there is no 'reminder.create' action (a
  // 'reminder.draft' row is internal state — resolvePendingAction refuses to flip it).
  // The wall gates only genuinely privileged actions: memory.forget, reminder.cancel (CANCELLING a
  // reminder removes something the house may rely on — creating one stays auto-commit) and github.issue.

  if (action.actionType === 'memory.forget') {
    // The TAP is the wall: the delete targets the exact fact ids + value strings resolved
    // at propose time (payload), scoped to this house, and runs only now. Facts are
    // removed; source messages are hidden (soft, reversible — A7) or surgically scrubbed (purge), never deleted.
    //
    // SCOPE = the pending action's STORED groupId (the house scope ingest resolved from the
    // authenticated lane at propose time) — NEVER the chat the button was tapped in (A1). A
    // card DMed to a member, or tapped in the migrated -100… supergroup, has a chatId that
    // owns no memory rows, so scoping by it deleted nothing while reporting "Forgotten".
    // Belt: the stored scope must still be THE house scope; otherwise fail closed.
    const { scopeId } = await resolveHouseIds(db)
    if (!scopeId || action.groupId !== scopeId) {
      await answerCallback(callbackId, 'This no longer applies.')
      if (messageId) await editMessageText(chatId, messageId, '✖️ Not applied — this card no longer matches the house.')
      return { ignored: 'scope-mismatch' }
    }
    const p = action.payload as {
      mode: ForgetMode
      factIds: string[]
      scrubValues: string[]
      noteIds: string[]
      aliasHits: AliasHit[]
      summary: string
    }
    const res = await step.run('forget', () =>
      forgetMemory(db, action.groupId, {
        factIds: p.factIds ?? [],
        scrubValues: p.scrubValues ?? [],
        noteIds: p.noteIds ?? [],
        aliasHits: p.aliasHits ?? [],
        mode: p.mode,
      }),
    )
    await step.run('forget-audit', () =>
      writeAudit(db, 'memory.forget', String(fromId), p.summary ?? null, {
        mode: p.mode,
        facts: res.facts,
        messagesScrubbed: res.messagesScrubbed,
        messagesHidden: res.messagesHidden,
        aliasesRemoved: res.aliasesRemoved,
      }),
    )
    const verb = p.mode === 'purge' ? 'Purged' : 'Forgotten'
    const bits = [
      `${res.facts} fact${res.facts === 1 ? '' : 's'}`,
      res.messagesScrubbed ? `scrubbed ${res.messagesScrubbed} message${res.messagesScrubbed === 1 ? '' : 's'}` : '',
      res.messagesHidden ? `hid ${res.messagesHidden} message${res.messagesHidden === 1 ? '' : 's'}` : '',
      res.aliasesRemoved ? `${res.aliasesRemoved} alias${res.aliasesRemoved === 1 ? '' : 'es'}` : '',
    ].filter(Boolean)
    const detail = bits.join(' + ')
    await answerCallback(callbackId, verb)
    if (messageId) await editMessageText(chatId, messageId, `${p.mode === 'purge' ? '🔥' : '🧽'} ${verb} — ${detail}.`)
    return { confirmed: id, forgot: res.facts, scrubbed: res.messagesScrubbed }
  }

  if (action.actionType === 'reminder.cancel') {
    // The TAP is the wall (docs/spec/reminders.md §Cancelling from chat): cancel exactly the reminder ids
    // resolved at propose time — every unsent row of each one's series — in the STORED house scope, never
    // the chat the card was tapped in (A1). Visibility is re-checked against the TAPPER: a house reminder
    // may be cancelled by any member's tap; a personal DM reminder only by its creator.
    const { scopeId } = await resolveHouseIds(db)
    if (!scopeId || action.groupId !== scopeId) {
      await answerCallback(callbackId, 'This no longer applies.')
      if (messageId) await editMessageText(chatId, messageId, '✖️ Not applied — this card no longer matches the house.')
      return { ignored: 'scope-mismatch' }
    }
    const p = action.payload as { reminderIds?: string[]; labels?: string[]; target?: string }
    const cancelled = await step.run('reminder-cancel', () => cancelRemindersOnTap(db, action.groupId, p.reminderIds ?? [], String(fromId)))
    await step.run('reminder-cancel-audit', () =>
      writeAudit(db, 'reminder.cancel', String(fromId), p.target || null, { proposed: p.reminderIds ?? [], cancelled, labels: p.labels ?? [] }),
    )
    if (cancelled.length === 0) {
      await answerCallback(callbackId, 'Nothing to cancel')
      if (messageId) await editMessageText(chatId, messageId, '✖️ Nothing cancelled — that reminder already went out or was cancelled.')
      return { confirmed: id, remindersCancelled: 0 }
    }
    // Name only what really went: a one-off that was delivered meanwhile is not claimed. (A recurring
    // one that rolled over is cancelled via its successor, so its head id is not in the list — then
    // everything proposed is named.)
    const ids = p.reminderIds ?? []
    const direct = (p.labels ?? []).filter((_, i) => cancelled.includes(ids[i]))
    const named = direct.length ? direct : (p.labels ?? [])
    await answerCallback(callbackId, 'Reminder cancelled')
    if (messageId) await editMessageText(chatId, messageId, `🗑️ Cancelled:\n${named.join('\n')}`)
    return { confirmed: id, remindersCancelled: cancelled.length }
  }

  if (action.actionType === 'olympics.action') {
    // The TAP is the wall (docs/spec/olympics.md): the exact Olympics input resolved and validated at
    // propose time goes out now — AS the tapper, who is the asker (resolvePendingAction), with
    // X-Baumy-Confirmed and the Idempotency-Key minted with the card. The call is its own memoized
    // step, so an Inngest retry reuses its answer; and if Olympics did not answer, the card is put
    // back so the asker can tap again — with the SAME key, so Olympics still runs it at most once.
    const p = action.payload as unknown as OlympicsPending
    const result = (await step.run('olympics-call', () =>
      callOlympicsAction(p.name, p.input, { actor: tapper, idempotencyKey: p.idempotencyKey, confirmed: true }),
    )) as OlympicsResult<unknown>
    if (!result.ok && result.kind === 'unavailable') {
      const reopened = await step.run('olympics-reopen', () => reopenPendingAction(db, id))
      await answerCallback(callbackId, reopened ? "Olympics didn't answer — tap confirm again in a moment." : "Olympics didn't answer, and this card has expired.")
      if (!reopened && messageId) await editMessageText(chatId, messageId, `⚠️ Not done — Olympics didn't answer and the card expired. Ask me again.`)
      return { confirmed: id, olympics: 'unavailable', reopened }
    }
    await step.run('olympics-audit', () =>
      writeAudit(db, 'olympics.action', tapper, p.summary ?? null, {
        action: p.name,
        idempotencyKey: p.idempotencyKey,
        ok: result.ok,
        ...(result.ok ? {} : { kind: result.kind, code: result.kind === 'refused' ? result.code : null }),
      }),
    )
    await answerCallback(callbackId, result.ok ? 'Done' : 'Not done')
    if (messageId) await editMessageText(chatId, messageId, tapResultLine(p, result))
    return { confirmed: id, olympics: result.ok ? 'ok' : result.kind }
  }

  if (action.actionType === 'github.issue') {
    // File the enriched report as a GitHub issue (details resolved at propose time).
    const p = action.payload as { title: string; body: string; labels: string[]; type: string }
    // In its own step so a retry does NOT file a duplicate issue (createIssue is not idempotent).
    const issue = await step.run('github-issue', () => createIssue({ title: p.title, body: p.body, labels: p.labels }))
    await step.run('issue-audit', () => writeAudit(db, 'github.issue', String(fromId), p.title, { type: p.type, number: issue?.number ?? null }))
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
}

export const handleCallbackQuery = inngest.createFunction(
  { id: 'handle-callback-query', retries: 2 },
  { event: 'telegram/callback.received' },
  ({ event, step }) => runCallback(event, step as unknown as CallbackStep),
)
