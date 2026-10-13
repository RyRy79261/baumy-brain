import { type Database } from '@/db/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { memberDisplayNames } from '@/lib/identity/roster'
import { answerCallback } from '@/lib/telegram/client'
import { clearDoneItems, markShoppingUpdated, toggleListItem, type ToggleResult } from '@/lib/lists/store'
import { clearToast, parseShopCallback, toggleToast } from '@/lib/lists/live'
import { loadLiveRef, requestShoppingRender, runShoppingRender, type RenderRequest } from '@/lib/lists/board'
import type { TurnStep } from '@/lib/turn/step'

// A tap on the live shopping list (issue #25, docs/spec/shopping-list.md §Live list): `shop:chk:<id>`,
// `shop:clear`, `shop:refresh`, `shop:page:<n>`. Reached from runCallback AFTER its roster check, so the
// tapper is an ACTIVE member (Telegram-authenticated from.id). Everything else is code:
//   • the data must parse EXACTLY (parseShopCallback) — anything else is answered and dropped;
//   • the tapped message must be in the house chat AND be the stored live list — the house scope comes
//     from config, never from the button, and an item id from another house's row matches nothing
//     (toggleListItem keys on id + scope);
//   • an item tap SETS the state its button showed asked for (☐ → tick, ☑ → untick — read by the webhook
//     from the keyboard Telegram delivered), so a double tap is idempotent; the change is one memoized
//     step, then a short toast (its own step), then a render request (no debounce).
// Like every list write it auto-commits (capture tier, I5): there is no confirm step on a tick.

export interface ShopTap {
  callbackId: string
  fromId: number
  chatId: string
  messageId?: number | null
  data: string
  /** What the tapped item button showed asked for (☐ → tick, ☑ → untick); null → flip. */
  want?: 'tick' | 'untick' | null
}

export const STALE_LIST_TOAST = 'This list is no longer updated — use the pinned one.'

// The toast is best-effort: a callback query Telegram already considers too old must not fail the tap
// (the change is made and memoized; the render still follows).
async function toast(callbackId: string, text?: string): Promise<void> {
  try {
    await answerCallback(callbackId, text)
  } catch (err) {
    console.warn('[baumy/lists] answerCallbackQuery failed:', err instanceof Error ? err.message : err)
  }
}

export const FAILED_TAP_TOAST = 'Something went wrong — try again.'

export async function runShopTap(t: ShopTap, step: TurnStep, db: Database) {
  // Every toast is its own memoized step, so an Inngest replay never answers the callback twice; and if
  // anything below fails before the tapper got one, they get a failure toast instead of a spinner that
  // never stops (the error still propagates, so Inngest retries).
  let answered = false
  const say = async (id: string, text?: string) => {
    await step.run(id, () => toast(t.callbackId, text))
    answered = true
  }
  try {
    return await shopTap(t, step, db, say)
  } catch (err) {
    if (!answered) await toast(t.callbackId, FAILED_TAP_TOAST)
    throw err
  }
}

async function shopTap(t: ShopTap, step: TurnStep, db: Database, say: (id: string, text?: string) => Promise<void>) {
  const cb = parseShopCallback(t.data)
  if (!cb) {
    await say('shop-toast')
    return { ignored: 'bad-data' as const }
  }
  const ids = await resolveHouseIds(db)
  if (!ids.scopeId || !ids.acceptIds.includes(t.chatId)) {
    await say('shop-toast', 'Not authorized.')
    return { ignored: 'other-chat' as const }
  }
  // The tapped message must BE the stored live list: same chat AND same message id.
  const live = await loadLiveRef(db)
  if (!live || t.messageId == null || live.messageId !== t.messageId || live.chatId !== t.chatId) {
    await say('shop-toast', STALE_LIST_TOAST)
    return { ignored: 'stale-message' as const }
  }
  const scope = ids.scopeId
  const tapper = String(t.fromId)
  const name = async () => (await memberDisplayNames(db)).get(tapper) ?? null

  let render: RenderRequest
  let result: Record<string, unknown>
  if (cb.kind === 'chk') {
    const res = (await step.run('shop-toggle', () =>
      toggleListItem(db, { groupId: scope, itemId: cb.itemId, by: tapper, want: t.want ?? null }),
    )) as ToggleResult
    const changed = res.outcome === 'ticked' || res.outcome === 'unticked' || res.outcome === 'readded'
    if (changed) await step.run('shop-stamp', () => markShoppingUpdated(db, tapper))
    const who = await name()
    await say('shop-toast', toggleToast(res.outcome, res.item, who))
    render = { groupId: scope, reason: 'tap', focusItemId: cb.itemId }
    result = { toggled: res.outcome }
  } else if (cb.kind === 'clear') {
    const cleared = (await step.run('shop-clear', () => clearDoneItems(db, { groupId: scope }))) as number
    if (cleared > 0) await step.run('shop-stamp', () => markShoppingUpdated(db, tapper))
    await say('shop-toast', clearToast(cleared))
    render = { groupId: scope, reason: 'tap', page: 1 }
    result = { cleared }
  } else if (cb.kind === 'refresh') {
    await say('shop-toast', 'Up to date.')
    render = { groupId: scope, reason: 'tap', page: 1 }
    result = { refreshed: true }
  } else {
    await say('shop-toast')
    render = { groupId: scope, reason: 'tap', page: cb.page }
    result = { page: cb.page }
  }

  // Render through the one serialised render function — always, even when nothing changed (a stale
  // keyboard is brought up to date). If Inngest cannot be reached, render inline so the tapper still
  // sees it.
  const sent = (await step.run('shop-render', () => requestShoppingRender(render))) as boolean
  if (!sent) await runShoppingRender(step, () => db, render)
  return result
}
