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
//   • the change is one memoized step (an Inngest retry never toggles twice), then a short toast, then a
//     render request (no debounce — the tapper wants to see the tick).
// Like every list write it auto-commits (capture tier, I5): there is no confirm step on a tick.

export interface ShopTap {
  callbackId: string
  fromId: number
  chatId: string
  messageId?: number | null
  data: string
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

export async function runShopTap(t: ShopTap, step: TurnStep, db: Database) {
  const cb = parseShopCallback(t.data)
  if (!cb) {
    await toast(t.callbackId)
    return { ignored: 'bad-data' as const }
  }
  const ids = await resolveHouseIds(db)
  if (!ids.scopeId || !ids.acceptIds.includes(t.chatId)) {
    await toast(t.callbackId, 'Not authorized.')
    return { ignored: 'other-chat' as const }
  }
  const live = await loadLiveRef(db)
  if (!live || t.messageId == null || live.messageId !== t.messageId) {
    await toast(t.callbackId, STALE_LIST_TOAST)
    return { ignored: 'stale-message' as const }
  }
  const scope = ids.scopeId
  const tapper = String(t.fromId)
  const name = async () => (await memberDisplayNames(db)).get(tapper) ?? null

  let render: RenderRequest
  let result: Record<string, unknown>
  if (cb.kind === 'chk') {
    const res = (await step.run('shop-toggle', () => toggleListItem(db, { groupId: scope, itemId: cb.itemId, by: tapper }))) as ToggleResult
    if (res.outcome !== 'gone') await step.run('shop-stamp', () => markShoppingUpdated(db, tapper))
    await toast(t.callbackId, toggleToast(res.outcome, res.item, await name()))
    render = { groupId: scope, reason: 'tap', focusItemId: cb.itemId }
    result = { toggled: res.outcome }
  } else if (cb.kind === 'clear') {
    const cleared = (await step.run('shop-clear', () => clearDoneItems(db, { groupId: scope }))) as number
    if (cleared > 0) await step.run('shop-stamp', () => markShoppingUpdated(db, tapper))
    await toast(t.callbackId, clearToast(cleared))
    render = { groupId: scope, reason: 'tap', page: 1 }
    result = { cleared }
  } else if (cb.kind === 'refresh') {
    await toast(t.callbackId, 'Up to date.')
    render = { groupId: scope, reason: 'tap', page: 1 }
    result = { refreshed: true }
  } else {
    await toast(t.callbackId)
    render = { groupId: scope, reason: 'tap', page: cb.page }
    result = { page: cb.page }
  }

  // Render through the one serialised render function. If Inngest cannot be reached, render inline so
  // the tapper still sees the change.
  const sent = (await step.run('shop-render', () => requestShoppingRender(render))) as boolean
  if (!sent) await runShoppingRender(step, () => db, render)
  return result
}
