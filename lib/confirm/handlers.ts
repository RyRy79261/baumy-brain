import { type Database } from '@/db/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { reopenPendingAction, type ResolvedAction, type TapType } from '@/lib/confirm/store'
import { forgetMemory } from '@/lib/memory/forget'
import { cancelRemindersOnTap } from '@/lib/reminders/cancel'
import { createIssue } from '@/lib/github/issues'
import { writeAudit } from '@/lib/audit'
import { answerCallback, editMessageText } from '@/lib/telegram/client'
import { callOlympicsAction, type OlympicsResult } from '@/lib/olympics/client'
import { tapResultLine } from '@/lib/olympics/intents'
import { loginResultLine, type LoginPending } from '@/lib/olympics/login-approval'

// What each confirm-tap action DOES once a member's tap resolved it (security B4: group text can only
// propose; the authenticated tap executes). The dispatcher (lib/inngest/functions/callback.ts) has
// already checked the tapper is an active member, resolved the row exactly once (single-use, unexpired,
// requester-only where TAP_ACTIONS says so) and memoized that. One entry per TapType — the table's type
// makes a new action without a handler a compile error.

type Step = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }

export interface TapRun {
  db: Database
  step: Step
  /** The pending action's id. */
  id: string
  /** The authenticated tapper (from.id). */
  tapper: string
  callbackId: string
  /** The card that was tapped (rewritten with the outcome), when Telegram sent it. */
  card: { chatId: string; messageId: number } | null
}

export interface TapHandler<K extends TapType> {
  /** The stored scope must still be THE house scope, or the tap is refused (A1 belt). */
  scopeChecked?: boolean
  /** Absent for a card with no Confirm button (TAP_ACTIONS.confirmButton = false). */
  confirm?: (run: TapRun, action: Extract<ResolvedAction, { actionType: K }>) => Promise<Record<string, unknown>>
  /** Cancel / Deny. Default: "Cancelled". */
  cancel?: (run: TapRun, action: Extract<ResolvedAction, { actionType: K }>) => Promise<Record<string, unknown>>
}

/** Toast the tapper and rewrite the card (its keyboard goes). */
export async function settle(run: TapRun, toast: string | undefined, cardText?: string): Promise<void> {
  await answerCallback(run.callbackId, toast)
  if (cardText && run.card) await editMessageText(run.card.chatId, run.card.messageId, cardText)
}

/** The default Cancel. */
export async function cancelled(run: TapRun): Promise<Record<string, unknown>> {
  await settle(run, 'Cancelled', '✖️ Cancelled.')
  return { cancelled: run.id }
}

/** The A1 belt: the stored scope must still be the house scope. False = refused (already answered). */
export async function scopeStillHouse(run: TapRun, groupId: string): Promise<boolean> {
  const { scopeId } = await resolveHouseIds(run.db)
  if (scopeId && groupId === scopeId) return true
  await settle(run, 'This no longer applies.', '✖️ Not applied — this card no longer matches the house.')
  return false
}

// Olympics did not answer: put the card back so the asker can tap again — with the SAME stored
// Idempotency-Key, so Olympics still runs it at most once. Expired → say so.
async function reopenOrExpire(run: TapRun, stepId: string, lines: { again: string; expiredToast: string; expiredCard: string }): Promise<boolean> {
  const reopened = await run.step.run(stepId, () => reopenPendingAction(run.db, run.id))
  await settle(run, reopened ? lines.again : lines.expiredToast, reopened ? undefined : lines.expiredCard)
  return reopened
}

// ── Sign in with Baumy (docs/spec/olympics.md §Sign-in approval) ─────────────────────────────────────
// A number (`l:<id>:<n>`, approve) or Deny (cancel) — sent AS the member the card was sent to.
export async function answerLogin(run: TapRun, p: LoginPending, name: 'approve_login' | 'deny_login', input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // One key per answer: a retried tap resends it; a different number after a reopen is a new call.
  const key = `login-${run.id}-${'code' in input ? String(input.code) : 'deny'}`
  const result = (await run.step.run('olympics-login-call', () =>
    callOlympicsAction<{ outcome?: string }>(name, input, { actor: run.tapper, idempotencyKey: key, confirmed: true }),
  )) as OlympicsResult<{ outcome?: string }>
  if (!result.ok && result.kind === 'unavailable' && name === 'deny_login') {
    // The Deny already spent the card (cancelled, never reopened), so nobody can approve this sign-in
    // from Telegram. Only the notice to Olympics was lost: its screen waits out the request.
    await settle(
      run,
      "Denied. Olympics didn't answer, so its screen may wait until the sign-in times out.",
      "🚫 Denied — this sign-in can't be approved now. Olympics didn't answer, so the sign-in screen may wait until it times out.",
    )
    return { login: name, olympics: 'unavailable', reopened: false }
  }
  if (!result.ok && result.kind === 'unavailable') {
    const reopened = await reopenOrExpire(run, 'olympics-login-reopen', {
      again: "Olympics didn't answer — tap again in a moment.",
      expiredToast: "Olympics didn't answer, and this sign-in has expired.",
      expiredCard: "⚠️ Not done — Olympics didn't answer and the sign-in expired.",
    })
    return { login: name, olympics: 'unavailable', reopened }
  }
  await run.step.run('olympics-login-audit', () =>
    writeAudit(run.db, 'olympics.login', run.tapper, p.device, {
      action: name,
      requestId: p.requestId,
      ok: result.ok,
      ...(result.ok ? { outcome: result.data?.outcome ?? null } : { kind: result.kind, code: result.kind === 'refused' ? result.code : null }),
    }),
  )
  await settle(run, result.ok ? 'Done' : 'Not done', loginResultLine(p, result))
  return { login: name, olympics: result.ok ? (result.data?.outcome ?? 'ok') : result.kind }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const TAP_HANDLERS: { [K in TapType]: TapHandler<K> } = {
  'memory.forget': {
    // The delete targets the exact fact ids + value strings resolved at propose time, in the STORED
    // house scope — never the chat the button was tapped in (A1). Facts are removed; source messages
    // are hidden (soft, reversible — A7) or surgically scrubbed (purge), never deleted.
    scopeChecked: true,
    confirm: async (run, { payload: p, groupId }) => {
      const res = await run.step.run('forget', () =>
        forgetMemory(run.db, groupId, { factIds: p.factIds ?? [], scrubValues: p.scrubValues ?? [], noteIds: p.noteIds ?? [], aliasHits: p.aliasHits ?? [], mode: p.mode }),
      )
      await run.step.run('forget-audit', () =>
        writeAudit(run.db, 'memory.forget', run.tapper, p.summary ?? null, {
          mode: p.mode,
          facts: res.facts,
          messagesScrubbed: res.messagesScrubbed,
          messagesHidden: res.messagesHidden,
          aliasesRemoved: res.aliasesRemoved,
        }),
      )
      const verb = p.mode === 'purge' ? 'Purged' : 'Forgotten'
      const detail = [
        plural(res.facts, 'fact'),
        res.messagesScrubbed ? `scrubbed ${plural(res.messagesScrubbed, 'message')}` : '',
        res.messagesHidden ? `hid ${plural(res.messagesHidden, 'message')}` : '',
        res.aliasesRemoved ? plural(res.aliasesRemoved, 'alias', 'aliases') : '',
      ]
        .filter(Boolean)
        .join(' + ')
      await settle(run, verb, `${p.mode === 'purge' ? '🔥' : '🧽'} ${verb} — ${detail}.`)
      return { confirmed: run.id, forgot: res.facts, scrubbed: res.messagesScrubbed }
    },
  },

  'reminder.cancel': {
    // Cancel exactly the reminder ids resolved at propose time — every unsent row of each one's series —
    // in the STORED house scope. Visibility is re-checked against the TAPPER: a house reminder may be
    // cancelled by any member's tap; a personal DM reminder only by its creator (docs/spec/reminders.md).
    scopeChecked: true,
    confirm: async (run, { payload: p, groupId }) => {
      const ids = p.reminderIds ?? []
      const done = await run.step.run('reminder-cancel', () => cancelRemindersOnTap(run.db, groupId, ids, run.tapper))
      await run.step.run('reminder-cancel-audit', () =>
        writeAudit(run.db, 'reminder.cancel', run.tapper, p.target || null, { proposed: ids, cancelled: done, labels: p.labels ?? [] }),
      )
      if (done.length === 0) {
        await settle(run, 'Nothing to cancel', '✖️ Nothing cancelled — that reminder already went out or was cancelled.')
        return { confirmed: run.id, remindersCancelled: 0 }
      }
      // Name only what really went: a one-off delivered meanwhile is not claimed. (A recurring one that
      // rolled over is cancelled via its successor, so its head id is not in the list — then everything
      // proposed is named.)
      const direct = (p.labels ?? []).filter((_, i) => done.includes(ids[i]))
      await settle(run, 'Reminder cancelled', `🗑️ Cancelled:\n${(direct.length ? direct : (p.labels ?? [])).join('\n')}`)
      return { confirmed: run.id, remindersCancelled: done.length }
    },
    // "Cancelled" would read as "the reminder was cancelled" — the opposite of what the tap did.
    cancel: async (run) => {
      await settle(run, 'Kept', '✖️ Kept — no reminder was cancelled.')
      return { cancelled: run.id }
    },
  },

  'olympics.action': {
    // The exact Olympics input resolved and validated at propose time goes out now — AS the tapper, who
    // is the asker — with X-Baumy-Confirmed and the Idempotency-Key minted with the card. The call is its
    // own memoized step, so an Inngest retry reuses its answer (docs/spec/olympics.md).
    confirm: async (run, { payload: p }) => {
      const result = (await run.step.run('olympics-call', () =>
        callOlympicsAction(p.name, p.input, { actor: run.tapper, idempotencyKey: p.idempotencyKey, confirmed: true }),
      )) as OlympicsResult<unknown>
      if (!result.ok && result.kind === 'unavailable') {
        const reopened = await reopenOrExpire(run, 'olympics-reopen', {
          again: "Olympics didn't answer — tap confirm again in a moment.",
          expiredToast: "Olympics didn't answer, and this card has expired.",
          expiredCard: "⚠️ Not done — Olympics didn't answer and the card expired. Ask me again.",
        })
        return { confirmed: run.id, olympics: 'unavailable', reopened }
      }
      await run.step.run('olympics-audit', () =>
        writeAudit(run.db, 'olympics.action', run.tapper, p.summary ?? null, {
          action: p.name,
          idempotencyKey: p.idempotencyKey,
          ok: result.ok,
          ...(result.ok ? {} : { kind: result.kind, code: result.kind === 'refused' ? result.code : null }),
        }),
      )
      await settle(run, result.ok ? 'Done' : 'Not done', tapResultLine(p, result))
      return { confirmed: run.id, olympics: result.ok ? 'ok' : result.kind }
    },
  },

  'olympics.login': {
    // No Confirm button (TAP_ACTIONS.confirmButton = false): a number approves (the dispatcher's `l` verb
    // → answerLogin). Deny tells Olympics at once, so the waiting screen hears it.
    cancel: async (run, { payload: p }) => answerLogin(run, p, 'deny_login', { requestId: p.requestId }),
  },

  'github.issue': {
    confirm: async (run, { payload: p }) => {
      // Its own step, so a retry does NOT file a duplicate issue (createIssue is not idempotent).
      const issue = await run.step.run('github-issue', () => createIssue({ title: p.title, body: p.body, labels: p.labels }))
      await run.step.run('issue-audit', () => writeAudit(run.db, 'github.issue', run.tapper, p.title, { type: p.type, number: issue?.number ?? null }))
      if (issue) await settle(run, 'Filed', `✅ Filed #${issue.number} — ${issue.url}`)
      else await settle(run, "Couldn't file", "⚠️ Couldn't file that — GitHub isn't set up or the API errored. Nothing was posted.")
      return { confirmed: run.id, issue: issue?.number ?? null }
    },
  },
}

/** Run a resolved action's handler (narrowing the union once, here). */
export async function runTap(run: TapRun, action: ResolvedAction, verb: 'confirm' | 'cancel'): Promise<Record<string, unknown>> {
  const handler = TAP_HANDLERS[action.actionType] as TapHandler<TapType>
  if (verb === 'cancel') return handler.cancel ? handler.cancel(run, action as never) : cancelled(run)
  if (!handler.confirm) {
    await settle(run, undefined)
    return { ignored: 'bad-data' }
  }
  if (handler.scopeChecked && !(await scopeStillHouse(run, action.groupId))) return { ignored: 'scope-mismatch' }
  return handler.confirm(run, action as never)
}
