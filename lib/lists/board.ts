import { sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'
import { inngest } from '@/lib/inngest/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { currentList } from '@/lib/lists/store'
import { sendShoppingBoard, deleteMessage, editShoppingBoard } from '@/lib/telegram/client'
import { now as clockNow } from '@/lib/core/clock'
import { writeAudit } from '@/lib/audit'
import type { TurnStep } from '@/lib/turn/step'
import { boardItem } from '@/lib/lists/live'

// The shopping topic (docs/spec/shopping-list.md §Shopping topic, issue #21): after the list changes,
// Baumy posts the whole open list as ONE message in the house's shopping topic and deletes the previous
// one. Debounced in Inngest (2 minutes after the LAST change, keyed by the house), so a burst of adds is
// one post. Everything here is code: the destination is house config, the text is the table.

export const SHOPPING_CHANGED = 'lists/shopping.changed' as const
export const SHOPPING_DEBOUNCE = '2m' as const
/** SHOPPING_DEBOUNCE in ms — for the sandbox, which plays the debounce on its own clock. */
export const SHOPPING_DEBOUNCE_MS = 2 * 60_000
export const EMPTY_BOARD = 'The list is empty.'
export const MOVED_DOWN = '⬇️ The list moved down.'
export const NO_LONGER_UPDATED = 'This list is no longer updated.'
const TELEGRAM_MAX = 4096

// Item text is defanged by boardItem (lib/lists/live.ts, shared with the live list).
export { boardItem }

// The whole open list as one plain-text message: a header with the count, one item per line. Empty →
// the short line. Cut to fit one Telegram message, with what was left out counted.
export function shoppingBoardText(items: string[]): string {
  const lines = items.map(boardItem).filter((i) => i !== '')
  if (lines.length === 0) return EMPTY_BOARD
  const head = `🛒 Shopping list (${lines.length})`
  let text = head
  for (const [i, line] of lines.entries()) {
    const next = `${text}\n• ${line}`
    const rest = lines.length - i - 1
    // Leave room for the "…and N more." tail whenever something would still follow.
    const tail = rest > 0 ? `\n…and ${rest} more.`.length : 0
    if (next.length + tail > TELEGRAM_MAX) return `${text}\n…and ${lines.length - i} more.`
    text = next
  }
  return text
}

// Ask for a repost after a list write. Best-effort: a failed hand-off never fails (or retries) the
// write itself — the list stands, and the next change brings the topic up to date. NO event id: Inngest
// would drop every later change in 24h as a duplicate; the debounce is what folds a burst into one run.
export async function requestShoppingRepost(groupId: string): Promise<void> {
  if (!groupId) return
  try {
    await inngest.send({ name: SHOPPING_CHANGED, data: { groupId } })
  } catch (err) {
    console.warn('[baumy/lists] shopping repost request failed:', err instanceof Error ? err.message : err)
  }
}

export type RepostResult =
  | { status: 'no-topic' | 'paused' | 'other-house' | 'topic-gone' }
  | { status: 'posted'; messageId: number; previous: 'none' | 'deleted' | 'edited' | 'failed' }

type BoardRef = { chatId: string; messageId: number }

// Swap the stored list post for `next` (null = clear) and return what was stored BEFORE, in ONE
// statement: the row is locked (FOR UPDATE) and read and written together, so two overlapping reposts
// each get a different "previous" — A gets the one before it, B gets A's — and each retires exactly
// that one. (Reading the previous id at load time let both retire the same old post and orphan A's.)
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

// Take an old list post down: delete it, or — when Telegram refuses (e.g. older than 48h) — rewrite it
// to `fallback`, so it never reads as the current list. Never throws.
async function retire(prev: BoardRef, fallback: string): Promise<'deleted' | 'edited' | 'failed'> {
  if (await deleteMessage(prev.chatId, prev.messageId)) return 'deleted'
  if (await editShoppingBoard(prev.chatId, prev.messageId, fallback)) return 'edited'
  return 'failed'
}

// /shoppingoff: the last list post comes down too (deleted, else marked "no longer updated") and the
// stored id is cleared, so nothing in the old topic still looks like the live list.
export async function retireShoppingBoard(d: Database): Promise<'none' | 'deleted' | 'edited' | 'failed'> {
  const prev = await swapStoredBoard(d, null)
  return prev ? retire(prev, NO_LONGER_UPDATED) : 'none'
}

// Telegram's answer when the topic itself is gone or closed: a post there can never succeed, so
// retrying (and re-failing on every change) is pointless.
export function isTopicGone(err: unknown): boolean {
  const e = err as { description?: unknown; message?: unknown } | null
  const text = `${typeof e?.description === 'string' ? e.description : ''} ${typeof e?.message === 'string' ? e.message : ''}`
  return /message thread not found|TOPIC_CLOSED|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(text)
}

// The repost itself — one step per stage, so an Inngest retry never posts twice (a completed post is
// memoized). The sandbox drives it inline.
export async function runShoppingRepost(step: TurnStep, db: () => Database, groupId: string): Promise<RepostResult> {
  type Plan = { go: false; status: 'no-topic' | 'paused' | 'other-house' } | { go: true; sendId: string; threadId: number; text: string }
  const plan = (await step.run('shopping-load', async (): Promise<Plan> => {
    const d = db()
    const ids = await resolveHouseIds(d)
    // The event names the house; it must BE the house (one house today) — never post another scope's list.
    if (groupId !== ids.scopeId) return { go: false, status: 'other-house' }
    if (ids.shoppingThreadId == null) return { go: false, status: 'no-topic' }
    if (!(await loadResponsePolicy(d)).global_enabled) return { go: false, status: 'paused' }
    const items = (await currentList(d, ids.scopeId)).map((r) => r.item)
    return { go: true, sendId: ids.sendId, threadId: ids.shoppingThreadId, text: shoppingBoardText(items) }
  })) as Plan
  if (!plan.go) return { status: plan.status }

  // A topic that was deleted or closed is RETURNED, not thrown: no retries, and the next step clears it.
  const posted = (await step.run('shopping-post', async () => {
    try {
      return { messageId: await sendShoppingBoard(plan.sendId, plan.text, plan.threadId) }
    } catch (err) {
      if (isTopicGone(err)) return { gone: err instanceof Error ? err.message : String(err) }
      throw err
    }
  })) as { messageId: number } | { gone: string }

  if ('gone' in posted) {
    await step.run('shopping-topic-gone', async () => {
      const d = db()
      // Compare-and-set: only the topic this run tried — never one a housemate has set since.
      const cleared = await d
        .update(houseConfig)
        .set({ shoppingThreadId: null, updatedAt: clockNow() })
        .where(sql`${houseConfig.id} AND ${houseConfig.shoppingThreadId} = ${plan.threadId}`)
        .returning({ id: houseConfig.id })
      if (cleared.length) await writeAudit(d, 'shopping.topic.cleared', null, null, { threadId: plan.threadId, reason: posted.gone })
    })
    return { status: 'topic-gone' }
  }
  const messageId = posted.messageId

  // Swap in the new post and get back the one it replaces (atomically — see swapStoredBoard). A retried
  // step finds its own post already stored and retires nothing.
  const prev = (await step.run('shopping-save', () => swapStoredBoard(db(), { chatId: plan.sendId, messageId }))) as BoardRef | null

  const previous = (await step.run('shopping-retire', async () => {
    if (!prev || (prev.chatId === plan.sendId && prev.messageId === messageId)) return 'none' as const
    return retire(prev, MOVED_DOWN)
  })) as 'none' | 'deleted' | 'edited' | 'failed'

  return { status: 'posted', messageId, previous }
}

// After /resume (or the dashboard switch turning Baumy back on), the board may have missed changes made
// while paused: ask for a repost of the house's list. Best-effort, like every repost request.
export async function requestShoppingRepostForHouse(d: Database): Promise<void> {
  try {
    await requestShoppingRepost((await resolveHouseIds(d)).scopeId)
  } catch (err) {
    console.warn('[baumy/lists] shopping repost request failed:', err instanceof Error ? err.message : err)
  }
}
