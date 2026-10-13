import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { runShoppingRepost, SHOPPING_CHANGED, SHOPPING_DEBOUNCE } from '@/lib/lists/board'
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
