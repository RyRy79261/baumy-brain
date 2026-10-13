import { eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'
import { inngest } from '@/lib/inngest/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { loadResponsePolicy } from '@/lib/policy'
import { currentList } from '@/lib/lists/store'
import { sendShoppingBoard, deleteMessage, editShoppingBoard } from '@/lib/telegram/client'
import { now as clockNow } from '@/lib/core/clock'
import type { TurnStep } from '@/lib/turn/step'

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
const TELEGRAM_MAX = 4096

// An item is untrusted text (a housemate's words or the kiosk's request body). Printed as plain text it
// still must not TRIGGER anything: Telegram auto-detects @mentions (a ping), #hashtags, $cashtags and
// /commands (tappable — a tap sends it as the tapper). The sigil that starts such a word is swapped for
// its look-alike, so nothing parses; control/bidi characters go, and a newline can't fake a line of its
// own. Readable as before.
export function boardItem(raw: string): string {
  return (
    raw
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/@(?=\w)/g, '＠')
      .replace(/#(?=\w)/g, '＃')
      .replace(/\$(?=[A-Za-z])/g, '＄')
      .replace(/(?<!\w)\/(?=\w)/g, '∕')
  )
}

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
  | { status: 'no-topic' | 'paused' | 'other-house' }
  | { status: 'posted'; messageId: number; previous: 'none' | 'deleted' | 'edited' | 'failed' }

// The repost itself — one step per stage, so an Inngest retry never posts twice (a completed post is
// memoized) and never loses the old message id (read before the post). The sandbox drives it inline.
export async function runShoppingRepost(step: TurnStep, db: () => Database, groupId: string): Promise<RepostResult> {
  type Plan =
    | { go: false; status: 'no-topic' | 'paused' | 'other-house' }
    | { go: true; sendId: string; threadId: number; text: string; prev: { chatId: string; messageId: number } | null }
  const plan = (await step.run('shopping-load', async (): Promise<Plan> => {
    const d = db()
    const ids = await resolveHouseIds(d)
    // The event names the house; it must BE the house (one house today) — never post another scope's list.
    if (groupId !== ids.scopeId) return { go: false, status: 'other-house' }
    if (ids.shoppingThreadId == null) return { go: false, status: 'no-topic' }
    if (!(await loadResponsePolicy(d)).global_enabled) return { go: false, status: 'paused' }
    const [cfg] = await d
      .select({ chatId: houseConfig.shoppingMessageChatId, messageId: houseConfig.shoppingMessageId })
      .from(houseConfig)
      .limit(1)
    const items = (await currentList(d, ids.scopeId)).map((r) => r.item)
    return {
      go: true,
      sendId: ids.sendId,
      threadId: ids.shoppingThreadId,
      text: shoppingBoardText(items),
      prev: cfg?.chatId && cfg.messageId != null ? { chatId: cfg.chatId, messageId: cfg.messageId } : null,
    }
  })) as Plan
  if (!plan.go) return { status: plan.status }

  const messageId = (await step.run('shopping-post', () => sendShoppingBoard(plan.sendId, plan.text, plan.threadId))) as number

  await step.run('shopping-save', async () => {
    await db()
      .update(houseConfig)
      .set({ shoppingMessageChatId: plan.sendId, shoppingMessageId: messageId, updatedAt: clockNow() })
      .where(eq(houseConfig.id, true))
  })

  const previous = (await step.run('shopping-retire', async () => {
    const prev = plan.prev
    if (!prev || (prev.chatId === plan.sendId && prev.messageId === messageId)) return 'none' as const
    if (await deleteMessage(prev.chatId, prev.messageId)) return 'deleted' as const
    // Telegram refused the delete (e.g. older than 48h): never leave two current-looking lists.
    if (await editShoppingBoard(prev.chatId, prev.messageId, MOVED_DOWN)) return 'edited' as const
    return 'failed' as const
  })) as 'none' | 'deleted' | 'edited' | 'failed'

  return { status: 'posted', messageId, previous }
}
