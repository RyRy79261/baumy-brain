import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { runShoppingRender, SHOPPING_CHANGED, SHOPPING_DEBOUNCE, SHOPPING_DEBOUNCE_TIMEOUT, SHOPPING_RENDER } from '@/lib/lists/board'
import type { TurnStep } from '@/lib/turn/step'

// The live shopping list (docs/spec/shopping-list.md §Live list, issue #25).
//
// shopping-changed: every list write sends `lists/shopping.changed`; the debounce, keyed by the house,
// runs this ONCE 5 seconds after the LAST change (and at most 30 seconds after the first, so a long
// burst still shows), so a burst of adds is one edit. It only hands over to shopping-render, the ONE
// function that renders — so a debounced edit and a tap's edit never interleave.
export const shoppingChanged = inngest.createFunction(
  {
    id: 'shopping-changed',
    debounce: { period: SHOPPING_DEBOUNCE, timeout: SHOPPING_DEBOUNCE_TIMEOUT, key: 'event.data.groupId' },
    concurrency: { limit: 1, key: 'event.data.groupId' },
    retries: 2,
  },
  { event: SHOPPING_CHANGED },
  async ({ event, step }) => {
    await step.sendEvent('render', { name: SHOPPING_RENDER, data: { groupId: event.data.groupId, reason: 'change' } })
    return { requested: true }
  },
)

// shopping-render: ONE run at a time per house, so renders never interleave — each reads the list as it
// is then and edits the one live message. No debounce: a tap renders at once. Rate limits (429) come
// back as RetryAfterError (lib/lists/board.ts).
export const shoppingRender = inngest.createFunction(
  {
    id: 'shopping-render',
    concurrency: { limit: 1, key: 'event.data.groupId' },
    retries: 3,
  },
  { event: SHOPPING_RENDER },
  async ({ event, step }) => runShoppingRender(step as unknown as TurnStep, createHttpDb, event.data),
)
