import { describe, it, expect } from 'vitest'
import { handleTelegramMessage } from '@/lib/inngest/functions/ingest'
import { SCHEDULE } from '@/lib/inngest/schedule'
import { CRON_JOBS } from '@/lib/inngest/functions/crons'
import { functions } from '@/lib/inngest/functions'
import { shoppingChanged, shoppingRender } from '@/lib/inngest/functions/shopping'
import { SHOPPING_CHANGED, SHOPPING_DEBOUNCE, SHOPPING_DEBOUNCE_MS, SHOPPING_DEBOUNCE_TIMEOUT, SHOPPING_DEBOUNCE_TIMEOUT_MS, SHOPPING_RENDER } from '@/lib/lists/board'

// Function-level config that no handler test can see.
describe('inngest function config', () => {
  it('ingest runs one message at a time PER CHAT (F16: a correction is never superseded by the message it corrected)', () => {
    expect(handleTelegramMessage.opts.concurrency).toEqual([{ key: 'event.data.chatId', limit: 1 }])
  })
  it('every schedule entry is registered exactly once, with the table\'s cron and retries (incl. the F12 hygiene sweep)', () => {
    for (const e of SCHEDULE) {
      const fns = functions.filter((f) => f.opts.id === e.id)
      expect(fns, e.id).toHaveLength(1)
      expect((fns[0].opts as { triggers?: unknown }).triggers, e.id).toEqual([{ cron: e.cron }])
      expect(fns[0].opts.retries, e.id).toBe('retries' in e ? e.retries : undefined)
    }
    const crons = functions.filter((f) => ((f.opts as { triggers?: { cron?: string }[] }).triggers ?? []).some((t) => t.cron))
    expect(crons.map((f) => f.opts.id).sort()).toEqual(SCHEDULE.map((e) => e.id).sort()) // no cron outside the table
    expect(SCHEDULE.map((e) => e.id)).toContain('memory-hygiene')
  })
  it('every entry the sandbox plays has a one-step job, and every one-step job is in the table', () => {
    for (const e of SCHEDULE) if (e.sandbox === true) expect(CRON_JOBS, e.id).toHaveProperty(e.id)
    for (const id of Object.keys(CRON_JOBS)) expect(SCHEDULE.map((e) => e.id)).toContain(id)
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
