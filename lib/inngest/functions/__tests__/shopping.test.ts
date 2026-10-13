import { describe, it, expect, vi } from 'vitest'

// The two live-list functions' bodies (issue #25): the debounced change hands over to the ONE render
// function (never renders itself, so it can never interleave with a tap's render); the render function
// runs the render for the event's request. Config (debounce, concurrency): functions-config.test.ts.

vi.mock('@/lib/inngest/client', async (o) => {
  const actual = await o<typeof import('@/lib/inngest/client')>()
  return { ...actual, inngest: { ...actual.inngest, createFunction: (_a: unknown, _b: unknown, h: unknown) => ({ handler: h }) } }
})
const runShoppingRender = vi.fn(async (..._a: unknown[]) => ({ status: 'edited' }))
vi.mock('@/lib/lists/board', async (o) => ({ ...(await o<typeof import('@/lib/lists/board')>()), runShoppingRender: (...a: unknown[]) => runShoppingRender(...a) }))

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: unknown }) => Promise<unknown>
const fns = (await import('@/lib/inngest/functions/shopping')) as unknown as Record<'shoppingChanged' | 'shoppingRender', { handler: Handler }>

describe('shopping-changed → shopping-render', () => {
  it('a debounced change sends ONE render request (reason change) for the same house — and renders nothing itself', async () => {
    const sendEvent = vi.fn(async (..._a: unknown[]) => ({ ids: [] }))
    await fns.shoppingChanged.handler({ event: { data: { groupId: '-100h' } }, step: { sendEvent, run: vi.fn() } })
    expect(sendEvent).toHaveBeenCalledTimes(1)
    expect(sendEvent.mock.calls[0][1]).toEqual({ name: 'lists/shopping.render', data: { groupId: '-100h', reason: 'change' } })
    expect(runShoppingRender).not.toHaveBeenCalled()
  })

  it('shopping-render runs the render for exactly the request it was sent', async () => {
    const req = { groupId: '-100h', reason: 'tap', focusItemId: '00000000-0000-4000-8000-000000000001' }
    await fns.shoppingRender.handler({ event: { data: req }, step: { run: vi.fn() } })
    expect(runShoppingRender).toHaveBeenCalledTimes(1)
    expect(runShoppingRender.mock.calls[0][2]).toEqual(req)
  })
})
