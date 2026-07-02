import { and, cosineDistance, desc, eq, ne, sql } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { memoryItems, memoryEmbeddings } from '@/db/schema'
import { embed } from '@/lib/ai/embed'

// Retrieval helper (task-graph M3): pgvector cosine ANN, group-scoped, active
// only, top-k with a similarity floor. Recency/salience re-rank is a follow-up.
export interface RetrievedMemory {
  id: string
  content: string
  memoryType: string
  authoredBy: string | null
  similarity: number
}

export interface RetrieveOpts {
  groupId: string
  k?: number
  floor?: number
}

export async function retrieve(
  query: string,
  opts: RetrieveOpts,
  deps?: { db?: Database; embed?: (t: string) => Promise<number[]> },
): Promise<RetrievedMemory[]> {
  const db = deps?.db ?? createHttpDb()
  const embedFn = deps?.embed ?? embed
  const q = await embedFn(query)

  const similarity = sql<number>`1 - (${cosineDistance(memoryEmbeddings.embedding, q)})`
  const rows = await db
    .select({
      id: memoryItems.id,
      content: memoryItems.content,
      memoryType: memoryItems.memoryType,
      authoredBy: memoryItems.authoredBy,
      similarity,
    })
    .from(memoryItems)
    .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memoryItemId, memoryItems.id))
    // Grounding mode (memory-core #69): group-scoped, active, and EXCLUDING
    // quarantined (forwarded/bot) rows so poisoned content can never ground a reply.
    .where(
      and(
        eq(memoryItems.groupId, opts.groupId),
        eq(memoryItems.isActive, true),
        ne(memoryItems.trustLevel, 'quarantined'),
      ),
    )
    .orderBy(desc(similarity))
    .limit(opts.k ?? 8)

  const floor = opts.floor ?? 0.2
  return rows.filter((r) => Number(r.similarity) >= floor)
}
