import { and, eq, notExists, sql } from 'drizzle-orm'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { memoryItems, memoryEmbeddings } from '@/db/schema'
import { embed, EMBED_MODEL } from '@/lib/ai/embed'

// Backfill sweep. After an embedder swap the migration clears the old (wrong-space)
// vectors, so memory_items can lack a CURRENT-model embedding. This re-embeds a
// batch each run with Voyage until caught up, then no-ops. Idempotent: the
// (memory_item_id, model) uniqueness + onConflictDoNothing means re-runs add nothing.
export const reembedSweep = inngest.createFunction(
  { id: 'reembed-sweep' },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const reembedded = await step.run('reembed', async () => {
      const db = createHttpDb()
      const missing = await db
        .select({ id: memoryItems.id, content: memoryItems.content })
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.isActive, true),
            notExists(
              db
                .select({ x: sql`1` })
                .from(memoryEmbeddings)
                .where(and(eq(memoryEmbeddings.memoryItemId, memoryItems.id), eq(memoryEmbeddings.model, EMBED_MODEL))),
            ),
          ),
        )
        .limit(50)

      let n = 0
      for (const m of missing) {
        const vector = await embed(m.content)
        await db
          .insert(memoryEmbeddings)
          .values({ memoryItemId: m.id, model: EMBED_MODEL, embedding: vector })
          .onConflictDoNothing()
        n += 1
      }
      return n
    })
    return { reembedded }
  },
)
