import { describe, it, expect } from 'vitest'
import { handleTelegramMessage } from '@/lib/inngest/functions/ingest'
import { hygieneSweep } from '@/lib/inngest/functions/hygiene'
import { functions } from '@/lib/inngest/functions'
import { shoppingRepost, shoppingRender } from '@/lib/inngest/functions/shopping'
import { SHOPPING_CHANGED, SHOPPING_DEBOUNCE, SHOPPING_DEBOUNCE_MS, SHOPPING_RENDER } from '@/lib/lists/board'

// Function-level config that no handler test can see.
describe('inngest function config', () => {
  it('ingest runs one message at a time PER CHAT (F16: a correction is never superseded by the message it corrected)', () => {
    expect(handleTelegramMessage.opts.concurrency).toEqual([{ key: 'event.data.chatId', limit: 1 }])
  })
  it('the nightly hygiene sweep is registered (F12)', () => {
    expect(functions).toContain(hygieneSweep)
    expect(hygieneSweep.opts.id).toBe('memory-hygiene')
  })
  it('the shopping-topic repost is registered, debounced 2 minutes PER HOUSE, one run at a time per house (issue #21)', () => {
    expect(functions).toContain(shoppingRepost)
    expect(shoppingRepost.opts.id).toBe('shopping-repost')
    expect(shoppingRepost.opts.debounce).toEqual({ period: '2m', key: 'event.data.groupId' })
    expect(shoppingRepost.opts.concurrency).toEqual({ limit: 1, key: 'event.data.groupId' })
    expect(SHOPPING_DEBOUNCE).toBe('2m')
    expect(SHOPPING_DEBOUNCE_MS).toBe(2 * 60_000) // the sandbox plays the same debounce
    expect((shoppingRepost.opts as { triggers?: unknown }).triggers).toEqual([{ event: SHOPPING_CHANGED }])
  })
  it('the live-list render is registered: one run at a time PER HOUSE, no debounce (a tap renders at once — issue #25)', () => {
    expect(functions).toContain(shoppingRender)
    expect(shoppingRender.opts.id).toBe('shopping-render')
    expect(shoppingRender.opts.concurrency).toEqual({ limit: 1, key: 'event.data.groupId' })
    expect(shoppingRender.opts.debounce).toBeUndefined()
    expect((shoppingRender.opts as { triggers?: unknown }).triggers).toEqual([{ event: SHOPPING_RENDER }])
  })
})
