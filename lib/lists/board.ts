import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig, listItems } from '@/db/schema'
import { inngest } from '@/lib/inngest/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { memberDisplayNames } from '@/lib/identity/roster'
import { loadResponsePolicy } from '@/lib/policy'
import { liveListRows, loadShoppingSort, markShoppingUpdated } from '@/lib/lists/store'
import { renderLiveList, boardItem } from '@/lib/lists/live'
import {
  deleteMessage,
  editShoppingBoard,
  sendLiveList,
  editLiveList,
  pinMessage,
  unpinMessage,
  type LiveKeyboard,
  type LiveEditOutcome,
} from '@/lib/telegram/client'
import { send } from '@/lib/telegram/send'
import { RetryAfterError } from 'inngest'
import { houseTz } from '@/lib/env'
import { now as clockNow } from '@/lib/core/clock'
import { writeAudit } from '@/lib/audit'
import type { TurnStep } from '@/lib/turn/step'

// The live shopping list's effects (docs/spec/shopping-list.md §Live list, issue #25; it replaced the
// issue #21 "repost after every change" board): the change signal every list write sends, the one
// render that edits the live message, and /shoppingoff's take-down. Everything here is code: the
// destination is house config, the content is the table. The pure half is lib/lists/live.ts.

export const SHOPPING_CHANGED = 'lists/shopping.changed' as const
/** A burst of changes is ONE edit: the render waits until 5 seconds after the LAST change… */
export const SHOPPING_DEBOUNCE = '5s' as const
/** …but never more than 30 seconds after the first (Inngest's debounce timeout), so a long burst still shows. */
export const SHOPPING_DEBOUNCE_TIMEOUT = '30s' as const
/** The same two in ms — for the sandbox, which plays the debounce on its own clock. */
export const SHOPPING_DEBOUNCE_MS = 5_000
export const SHOPPING_DEBOUNCE_TIMEOUT_MS = 30_000
export const NO_LONGER_UPDATED = 'This list is no longer updated.'

// Item text is defanged by boardItem (lib/lists/live.ts).
export { boardItem }

// After a list write that CHANGED something: stamp who did it (the "Last updated by" line) and send the
// change signal — debounced per house by shopping-changed, which then asks for ONE render (an edit).
// Every writer of baumy_list_items calls this (runList, the kitchen API; a tap stamps and renders itself).
// Best-effort: a failure here never fails (or retries) the write — the list stands, and the next change
// brings the message up to date. NO event id: Inngest would drop every later change in 24h as a duplicate.
export async function noteShoppingChange(d: Database, groupId: string, by: string | null): Promise<void> {
  if (!groupId) return
  try {
    await markShoppingUpdated(d, by)
  } catch (err) {
    console.warn('[baumy/lists] shopping "last updated" stamp failed:', err instanceof Error ? err.message : err)
  }
  await requestShoppingRefresh(groupId)
}

// The change signal alone (no stamp): /resume and the dashboard switch, after a pause held renders back.
export async function requestShoppingRefresh(groupId: string): Promise<void> {
  if (!groupId) return
  try {
    await inngest.send({ name: SHOPPING_CHANGED, data: { groupId } })
  } catch (err) {
    console.warn('[baumy/lists] shopping change signal failed:', err instanceof Error ? err.message : err)
  }
}

export async function requestShoppingRefreshForHouse(d: Database): Promise<void> {
  try {
    await requestShoppingRefresh((await resolveHouseIds(d)).scopeId)
  } catch (err) {
    console.warn('[baumy/lists] shopping change signal failed:', err instanceof Error ? err.message : err)
  }
}

// ── Auto-sorting's event (issue #29) — here, not in lib/lists/categorize.ts, because the render below
// sends it too (the backfill) and categorize.ts already imports this module. ─────────────────────────────

export const SHOPPING_CATEGORIZE = 'lists/shopping.categorize' as const
/** At most this many rows per event — one add is at most 30 items (the store's cap). */
export const CATEGORIZE_MAX_IDS = 30
/** A row younger than this still has its own categorize event in flight: the backfill leaves it alone. */
export const BACKFILL_AFTER_MS = 60_000

// Ask for auto-sorting of these rows. Best-effort: false (logged) when Inngest could not be reached — the
// items stay "Not sorted" (the next render's backfill picks them up) and the write stands. It awaits one
// Inngest send (a few ms); it never fails the write.
export async function requestCategorize(groupId: string, itemIds: string[]): Promise<boolean> {
  if (!groupId || itemIds.length === 0) return false
  try {
    await inngest.send({ name: SHOPPING_CATEGORIZE, data: { groupId, itemIds: itemIds.slice(0, CATEGORIZE_MAX_IDS) } })
    return true
  } catch (err) {
    console.warn('[baumy/lists] categorize request failed:', err instanceof Error ? err.message : err)
    return false
  }
}

// Open rows of this house never tried by auto-sorting (category_source and categorized_at both NULL) and
// older than BACKFILL_AFTER_MS: the list as it was before auto-sorting existed, or a row whose own event
// was lost. Oldest first, at most CATEGORIZE_MAX_IDS.
export async function backfillCandidates(d: Database, groupId: string): Promise<string[]> {
  const rows = await d
    .select({ id: listItems.id })
    .from(listItems)
    .where(
      and(
        eq(listItems.groupId, groupId),
        eq(listItems.isActive, true),
        isNull(listItems.checkedAt),
        isNull(listItems.categorySource),
        isNull(listItems.categorizedAt),
        lt(listItems.createdAt, new Date(clockNow().getTime() - BACKFILL_AFTER_MS)),
      ),
    )
    .orderBy(asc(listItems.createdAt))
    .limit(CATEGORIZE_MAX_IDS)
  return rows.map((r) => r.id)
}

type BoardRef = { chatId: string; messageId: number }

// Swap the stored live message for `next` (null = clear) and return what was stored BEFORE, in ONE
// statement: the row is locked (FOR UPDATE) and read and written together, so two overlapping callers
// each get a different "previous" and each retires exactly that one.
export async function swapStoredBoard(d: Database, next: BoardRef | null): Promise<BoardRef | null> {
  const res = (await d.execute(sql`
    WITH old AS (
      SELECT shopping_message_chat_id AS chat_id, shopping_message_id AS message_id
      FROM baumy_house_config WHERE id FOR UPDATE
    )
    UPDATE baumy_house_config
    SET shopping_message_chat_id = ${next?.chatId ?? null},
        shopping_message_id = ${next?.messageId ?? null},
        updated_at = ${clockNow().toISOString()}
    FROM old
    WHERE baumy_house_config.id
    RETURNING old.chat_id, old.message_id
  `)) as unknown
  type Row = { chat_id: string | null; message_id: string | number | null }
  // neon-http and PGlite shape the result differently (as retrieve.ts handles it).
  const row = (Array.isArray(res) ? (res as Row[]) : ((res as { rows?: Row[] }).rows ?? []))[0]
  return row?.chat_id && row.message_id != null ? { chatId: row.chat_id, messageId: Number(row.message_id) } : null
}

// Take an old live message down: delete it, or — when Telegram refuses — rewrite it to `fallback` with no
// keyboard (an edit without reply_markup drops the buttons), so it never reads as the live list. Never throws.
async function retire(prev: BoardRef, fallback: string): Promise<'deleted' | 'edited' | 'failed'> {
  if (await deleteMessage(prev.chatId, prev.messageId)) return 'deleted'
  if (await editShoppingBoard(prev.chatId, prev.messageId, fallback)) return 'edited'
  return 'failed'
}

// /shoppingoff: the live list stops. Its stored id is cleared first (so no render can edit or re-post it),
// then the message is unpinned and deleted — or marked "This list is no longer updated." without buttons.
export async function retireShoppingBoard(d: Database): Promise<'none' | 'deleted' | 'edited' | 'failed'> {
  const prev = await swapStoredBoard(d, null)
  if (!prev) return 'none'
  await unpinMessage(prev.chatId, prev.messageId)
  return retire(prev, NO_LONGER_UPDATED)
}

// Telegram's answer when the topic itself is gone or closed: a post there can never succeed, so
// retrying (and re-failing on every change) is pointless.
export function isTopicGone(err: unknown): boolean {
  const e = err as { description?: unknown; message?: unknown } | null
  const text = `${typeof e?.description === 'string' ? e.description : ''} ${typeof e?.message === 'string' ? e.message : ''}`
  return /message thread not found|TOPIC_CLOSED|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(text)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The live list (issue #25, docs/spec/shopping-list.md §Live list): ONE message per house, posted once,
// pinned silently, and EDITED in place on every change. Every render — after a tap, after the debounced
// change event, for /list and /shoppinghere — goes through `lists/shopping.render` and ONE Inngest
// function with concurrency 1 per house (shopping-render), so renders never interleave: each reads the
// list as it is then, and the last one shows the last state. The only writer of the stored message id.

export const SHOPPING_RENDER = 'lists/shopping.render' as const

/** Where /list or /shoppinghere was sent: the house chat and its forum topic (null = General). */
export interface RenderPlace {
  chatId: string
  threadId: number | null
  /** /shoppinghere: MOVE the live list here when it lives elsewhere. /list: leave it where it is. */
  move: boolean
}

export interface RenderRequest {
  groupId: string
  /** Why: `change` (the debounced list change — held while /pause'd), `tap` (a button), `command`. */
  reason: 'change' | 'tap' | 'command'
  /** The page to show (1-based; ◀ / ▶), or the page holding this item (the one just tapped). */
  page?: number
  focusItemId?: string
  place?: RenderPlace
}

// Ask for a render. Best-effort: false (logged) when Inngest could not be reached — the list write stands
// and the next change or tap brings the message up to date. NO event id (it would dedupe later renders).
export async function requestShoppingRender(req: RenderRequest): Promise<boolean> {
  if (!req.groupId) return false
  try {
    await inngest.send({ name: SHOPPING_RENDER, data: req })
    return true
  } catch (err) {
    console.warn('[baumy/lists] shopping render request failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export type LiveRef = { chatId: string; messageId: number; threadId: number | null }

export type RenderResult =
  | { status: 'other-house' | 'paused' | 'no-message' | 'superseded' | 'topic-gone' }
  | { status: 'edited' | 'unchanged'; messageId: number; pinned: boolean | null; pointer: boolean }
  | { status: 'posted'; messageId: number; pinned: boolean; previous: 'none' | 'deleted' | 'edited' | 'failed' }

// Telegram's flood control (429) → let Inngest retry the step after the wait Telegram asked for.
function rethrowRateLimit(err: unknown): never {
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } } | null
  if (e?.error_code === 429) {
    const secs = typeof e.parameters?.retry_after === 'number' ? e.parameters.retry_after : 5
    throw new RetryAfterError('[baumy/lists] Telegram rate limit on the live list', secs * 1000, { cause: err })
  }
  throw err
}

export async function loadLiveRef(d: Database): Promise<LiveRef | null> {
  const [cfg] = await d
    .select({ chat: houseConfig.shoppingMessageChatId, id: houseConfig.shoppingMessageId, thread: houseConfig.shoppingThreadId })
    .from(houseConfig)
    .limit(1)
  return cfg?.chat && cfg.id != null ? { chatId: cfg.chat, messageId: Number(cfg.id), threadId: cfg.thread ?? null } : null
}

// Store `next` as the live list — compare-and-set on the message id this run expected to replace (null =
// none), so a render never overwrites a message another path stored (or cleared, /shoppingoff) meanwhile.
async function storeLiveRef(d: Database, expected: number | null, next: LiveRef): Promise<boolean> {
  const rows = await d
    .update(houseConfig)
    .set({ shoppingMessageChatId: next.chatId, shoppingMessageId: next.messageId, shoppingThreadId: next.threadId, updatedAt: clockNow() })
    .where(expected == null ? sql`${houseConfig.id} AND ${houseConfig.shoppingMessageId} IS NULL` : sql`${houseConfig.id} AND ${houseConfig.shoppingMessageId} = ${expected}`)
    .returning({ id: houseConfig.id })
  return rows.length > 0
}

// A link to a message in a supergroup (t.me/c/…), or null for a basic group (no such link exists).
export function messageLink(chatId: string, messageId: number): string | null {
  return /^-100\d+$/.test(chatId) ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null
}

// What /list says when the live list lives in another place (General or another topic): where it is.
export const LIVE_ELSEWHERE = (link: string | null) =>
  link ? `🛒 The live shopping list is pinned here: ${link}` : '🛒 The live shopping list is pinned in the group.'

// Read the list and build the message NOW — called INSIDE the step that sends it, never in an earlier
// one. Inngest's concurrency limit bounds executing STEPS, not runs, so two renders' steps can interleave:
// a view built in one step and sent in a later one could be stale by then (and a retried send would
// replay the old text). Built and sent in one step, every edit carries the list as it is when it goes out.
async function buildView(d: Database, scopeId: string, req: RenderRequest): Promise<{ text: string; keyboard: LiveKeyboard }> {
  const [cfg] = await d.select({ by: houseConfig.shoppingUpdatedBy, at: houseConfig.shoppingUpdatedAt }).from(houseConfig).limit(1)
  const name = cfg?.by ? ((await memberDisplayNames(d)).get(cfg.by) ?? null) : null
  const view = renderLiveList({
    rows: await liveListRows(d, scopeId),
    sort: await loadShoppingSort(d),
    now: clockNow(),
    page: req.page,
    focusItemId: req.focusItemId ?? null,
    updatedBy: name,
    updatedAt: cfg?.at ?? null,
    tz: houseTz(),
  })
  return { text: view.text, keyboard: view.keyboard }
}

const sameRef = (a: LiveRef | null, b: { chatId: string; messageId: number } | null) =>
  a != null && b != null && a.chatId === b.chatId && a.messageId === b.messageId

// One render: edit the live list in place; post it (and pin it, silently) only for /list or /shoppinghere
// with none yet, for /shoppinghere moving it, or when the stored message was deleted. Each Telegram send is
// ONE step that also reads the list and builds the text (buildView), so a retry never posts twice and
// never sends stale text. The sandbox drives it inline.
export async function runShoppingRender(step: TurnStep, db: () => Database, req: RenderRequest): Promise<RenderResult> {
  const result = await renderOnce(step, db, req)
  // After the render (it never delays the edit): the one-off sort of rows auto-sorting never saw (issue
  // #29) — after a deploy, the first render of the old list sorts it, 30 rows a time; each sorted batch's
  // own re-render brings the next. Idempotent (a tried row never matches again) and best-effort.
  // Not while the house is paused (/pause): a backfill spends Sonnet / Voyage calls on nobody's request.
  if (result.status !== 'other-house' && result.status !== 'paused') {
    await step.run('live-backfill', async () => {
      try {
        // …nor on a tap or command render during the pause (they still render; they do not backfill).
        if (!(await loadResponsePolicy(db())).global_enabled) return false
        const ids = await backfillCandidates(db(), req.groupId)
        return ids.length ? await requestCategorize(req.groupId, ids) : false
      } catch (err) {
        console.warn('[baumy/lists] categorize backfill failed:', err instanceof Error ? err.message : err)
        return false
      }
    })
  }
  return result
}

async function renderOnce(step: TurnStep, db: () => Database, req: RenderRequest): Promise<RenderResult> {
  type First =
    | { status: 'other-house' | 'paused' | 'no-message' | 'superseded' }
    | { status: 'edited' | 'unchanged'; stored: LiveRef }
    | { status: 'post'; sendId: string; scopeId: string; expected: LiveRef | null; postThread: number | null; moving: boolean }
  const first = (await step.run('live-render', async (): Promise<First> => {
    const d = db()
    const ids = await resolveHouseIds(d)
    // The event names the house; it must BE the house (one house today) — never render another scope's list.
    if (req.groupId !== ids.scopeId) return { status: 'other-house' }
    // A place must be the house itself (the command's own chat — the caller checked the lane too).
    if (req.place && !ids.acceptIds.includes(req.place.chatId)) return { status: 'other-house' }
    if (req.reason === 'change' && !(await loadResponsePolicy(d)).global_enabled) return { status: 'paused' }
    const stored = await loadLiveRef(d)
    if (!stored && !req.place) return { status: 'no-message' }
    // /shoppinghere somewhere else MOVES the list (a new post there); otherwise an existing one is edited.
    const moving = !!(stored && req.place?.move && stored.threadId !== req.place.threadId)
    // Where a NEW post goes: where the command was sent, else where the list lived (its topic).
    const postThread = req.place ? req.place.threadId : (stored?.threadId ?? null)
    const post = { status: 'post' as const, sendId: ids.sendId, scopeId: ids.scopeId, expected: stored, postThread, moving }
    if (!stored || moving) return post

    const view = await buildView(d, ids.scopeId, req)
    // Compare-and-set: the stored live message must still be the one this render is about to edit — never
    // edit a message /shoppingoff (or a newer post) has just taken over.
    if (!sameRef(await loadLiveRef(d), stored)) return { status: 'superseded' }
    let edited: LiveEditOutcome
    try {
      edited = await editLiveList(stored.chatId, stored.messageId, view.text, view.keyboard)
    } catch (err) {
      rethrowRateLimit(err)
    }
    if (edited === 'gone') return post // deleted: post a fresh one below
    // …and after: if the message stopped being the live list WHILE it was being edited (/shoppingoff
    // cleared the id, then marked it "no longer updated"), put that marker back over this edit.
    if (!sameRef(await loadLiveRef(d), stored)) {
      await editShoppingBoard(stored.chatId, stored.messageId, NO_LONGER_UPDATED)
      return { status: 'superseded' }
    }
    return { status: edited, stored }
  })) as First

  if (first.status === 'edited' || first.status === 'unchanged') {
    const stored = first.stored
    // /list (or /shoppinghere in the same place) also makes sure it is pinned, and /list from another
    // place says where the live list is rather than making a second one.
    const pinned = req.place ? ((await step.run('live-pin', () => pinMessage(stored.chatId, stored.messageId))) as boolean) : null
    let pointer = false
    if (req.place && stored.threadId !== req.place.threadId) {
      const place = req.place
      await step.run('live-pointer', () => send({ to: 'chat', chatId: place.chatId, threadId: place.threadId }, LIVE_ELSEWHERE(messageLink(stored.chatId, stored.messageId))))
      pointer = true
    }
    return { status: first.status, messageId: stored.messageId, pinned, pointer }
  }
  if (first.status !== 'post') return { status: first.status }

  const plan = first
  const expectedId = plan.expected?.messageId ?? null
  // Post + store in ONE step, the text built inside it. A retry after a failed send posts again (nothing
  // was posted); a store that loses its compare-and-set takes the fresh post down again in the same step.
  const posted = (await step.run('live-post', async () => {
    const d = db()
    // Re-read first: if the stored list changed since this render started (/shoppingoff, another post),
    // this render is out of date — never post over it.
    if (((await loadLiveRef(d))?.messageId ?? null) !== expectedId) return { superseded: true as const }
    const view = await buildView(d, plan.scopeId, req)
    let messageId: number
    try {
      messageId = await sendLiveList(plan.sendId, view.text, view.keyboard, plan.postThread)
    } catch (err) {
      if (isTopicGone(err)) return { gone: err instanceof Error ? err.message : String(err) }
      rethrowRateLimit(err)
    }
    let stored = false
    try {
      stored = await storeLiveRef(d, expectedId, { chatId: plan.sendId, messageId, threadId: plan.postThread })
    } catch (err) {
      await deleteMessage(plan.sendId, messageId) // never leave an unrecorded second list behind a retry
      throw err
    }
    if (!stored) {
      // Lost the race to another path: take our post down again, so there is never a second live list.
      await deleteMessage(plan.sendId, messageId)
      return { superseded: true as const }
    }
    return { messageId }
  })) as { messageId: number } | { gone: string } | { superseded: true }
  if ('superseded' in posted) return { status: 'superseded' }

  if ('gone' in posted) {
    await step.run('live-topic-gone', async () => {
      const d = db()
      // Compare-and-set: only the topic this run tried — never one a housemate has set since.
      const where =
        plan.postThread == null
          ? sql`${houseConfig.id} AND ${houseConfig.shoppingThreadId} IS NULL`
          : sql`${houseConfig.id} AND ${houseConfig.shoppingThreadId} = ${plan.postThread}`
      const cleared = await d
        .update(houseConfig)
        .set({ shoppingThreadId: null, shoppingMessageChatId: null, shoppingMessageId: null, updatedAt: clockNow() })
        .where(where)
        .returning({ id: houseConfig.id })
      if (cleared.length) await writeAudit(d, 'shopping.topic.cleared', null, null, { threadId: plan.postThread, reason: posted.gone })
    })
    return { status: 'topic-gone' }
  }
  const messageId = posted.messageId
  const pinned = (await step.run('live-pin', () => pinMessage(plan.sendId, messageId))) as boolean

  // Moved (/shoppinghere elsewhere): the old message comes down — unpinned, then deleted, or marked
  // "no longer updated" (keyboard dropped) when Telegram refuses the delete.
  const prev = plan.moving ? plan.expected : null
  const previous = (await step.run('live-retire', async () => (prev ? retireLive(prev) : ('none' as const)))) as 'none' | 'deleted' | 'edited' | 'failed'
  return { status: 'posted', messageId, pinned, previous }
}

async function retireLive(prev: BoardRef): Promise<'deleted' | 'edited' | 'failed'> {
  await unpinMessage(prev.chatId, prev.messageId)
  return retire(prev, NO_LONGER_UPDATED)
}
