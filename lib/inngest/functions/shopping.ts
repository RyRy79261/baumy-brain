import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { runShoppingRepost, runShoppingRender, SHOPPING_CHANGED, SHOPPING_DEBOUNCE, SHOPPING_RENDER } from '@/lib/lists/board'
import type { TurnStep } from '@/lib/turn/step'

// The shopping topic repost (docs/spec/shopping-list.md §Shopping topic, issue #21). Every list write
// sends `lists/shopping.changed`; the debounce, keyed by the house, runs this ONCE about 2 minutes after
// the LAST change, so a burst of adds is one post. Concurrency 1 per house: two runs never race on the
// stored message id. The work is runShoppingRepost (one step per stage), shared with the sandbox.
export const shoppingRepost = inngest.createFunction(
  {
    id: 'shopping-repost',
    debounce: { period: SHOPPING_DEBOUNCE, key: 'event.data.groupId' },
    concurrency: { limit: 1, key: 'event.data.groupId' },
    retries: 2,
  },
  { event: SHOPPING_CHANGED },
  async ({ event, step }) => runShoppingRepost(step as unknown as TurnStep, createHttpDb, event.data.groupId),
)

// The live list render (docs/spec/shopping-list.md §Live list, issue #25): ONE run at a time per house,
// so renders never interleave — each reads the list as it is then and edits the one live message. No
// debounce: a tap renders at once. Rate limits (429) come back as RetryAfterError (lib/lists/board.ts).
export const shoppingRender = inngest.createFunction(
  {
    id: 'shopping-render',
    concurrency: { limit: 1, key: 'event.data.groupId' },
    retries: 3,
  },
  { event: SHOPPING_RENDER },
  async ({ event, step }) => runShoppingRender(step as unknown as TurnStep, createHttpDb, event.data),
)
