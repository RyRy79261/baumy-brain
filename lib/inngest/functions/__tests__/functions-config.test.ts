import { describe, it, expect } from 'vitest'
import { handleTelegramMessage } from '@/lib/inngest/functions/ingest'
import { hygieneSweep } from '@/lib/inngest/functions/hygiene'
import { functions } from '@/lib/inngest/functions'
import { shoppingChanged, shoppingRender } from '@/lib/inngest/functions/shopping'
import { SHOPPING_CHANGED, SHOPPING_DEBOUNCE, SHOPPING_DEBOUNCE_MS, SHOPPING_DEBOUNCE_TIMEOUT, SHOPPING_DEBOUNCE_TIMEOUT_MS, SHOPPING_RENDER } from '@/lib/lists/board'

// Function-level config that no handler test can see.
describe('inngest function config', () => {
  it('ingest runs one message at a time PER CHAT (F16: a correction is never superseded by the message it corrected)', () => {
    expect(handleTelegramMessage.opts.concurrency).toEqual([{ key: 'event.data.chatId', limit: 1 }])
  })
  it('the nightly hygiene sweep is registered (F12)', () => {
    expect(functions).toContain(hygieneSweep)
    expect(hygieneSweep.opts.id).toBe('memory-hygiene')
  })
  it('a list change is debounced 5 seconds PER HOUSE with a 30-second max wait, then hands over to the render (issue #25)', () => {
    expect(functions).toContain(shoppingChanged)
    expect(shoppingChanged.opts.id).toBe('shopping-changed')
    expect(shoppingChanged.opts.debounce).toEqual({ period: '5s', timeout: '30s', key: 'event.data.groupId' })
    expect(shoppingChanged.opts.concurrency).toEqual({ limit: 1, key: 'event.data.groupId' })
    expect([SHOPPING_DEBOUNCE, SHOPPING_DEBOUNCE_TIMEOUT]).toEqual(['5s', '30s'])
    expect([SHOPPING_DEBOUNCE_MS, SHOPPING_DEBOUNCE_TIMEOUT_MS]).toEqual([5_000, 30_000]) // the sandbox plays the same debounce
    expect((shoppingChanged.opts as { triggers?: unknown }).triggers).toEqual([{ event: SHOPPING_CHANGED }])
  })
  it('the live-list render is registered: one run at a time PER HOUSE, no debounce (a tap renders at once — issue #25)', () => {
    expect(functions).toContain(shoppingRender)
    expect(shoppingRender.opts.id).toBe('shopping-render')
    expect(shoppingRender.opts.concurrency).toEqual({ limit: 1, key: 'event.data.groupId' })
    expect(shoppingRender.opts.debounce).toBeUndefined()
    expect((shoppingRender.opts as { triggers?: unknown }).triggers).toEqual([{ event: SHOPPING_RENDER }])
  })
  it('a callback that finally fails is still answered (onFailure — no endless button spinner)', async () => {
    const { handleCallbackQuery } = await import('@/lib/inngest/functions/callback')
    expect(typeof (handleCallbackQuery.opts as { onFailure?: unknown }).onFailure).toBe('function')
  })
})
