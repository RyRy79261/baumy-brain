import { createHttpDb, type Database } from '@/db/client'
import { telegramChats, members, memoryItems, memoryEmbeddings, replies } from '@/db/schema'
import { embed } from '@/lib/ai/embed'
import type { Trust } from '@/lib/core/origin'

const EMBED_MODEL = 'text-embedding-3-small'

// Minimal registration so FK-bound memory writes succeed. Full B10 member
// auto-discovery + bootstrap arrive with the auth phase; this is idempotent.
export async function ensureRegistered(db: Database, groupId: string, fromId: number | null): Promise<void> {
  await db.insert(telegramChats).values({ chatId: groupId, kind: 'house_group', isPrimary: true }).onConflictDoNothing()
  if (fromId != null) {
    await db.insert(members).values({ telegramUserId: String(fromId), groupId }).onConflictDoNothing()
  }
}

export interface CaptureInput {
  groupId: string
  content: string
  memoryType: string
  authoredBy: string | null
  trustLevel: Trust
}

export interface MemoryDeps {
  db: Database
  embed: (t: string) => Promise<number[]>
}

// Evidence-layer capture (M1/M3 substrate): store the item + its embedding — the
// semantic-recall base. Structured fact extraction + reconcile/supersede (M2) is
// the follow-up; this alone gives working store-then-recall.
export async function captureMemory(input: CaptureInput, deps?: Partial<MemoryDeps>): Promise<string> {
  const db = deps?.db ?? createHttpDb()
  const embedFn = deps?.embed ?? embed
  const vector = await embedFn(input.content)

  const [item] = await db
    .insert(memoryItems)
    .values({
      groupId: input.groupId,
      sourceKind: 'message',
      memoryType: input.memoryType,
      content: input.content,
      authoredBy: input.authoredBy,
      trustLevel: input.trustLevel,
    })
    .returning({ id: memoryItems.id })

  await db.insert(memoryEmbeddings).values({ memoryItemId: item.id, model: EMBED_MODEL, embedding: vector })
  return item.id
}

// Claim-before-send guard (D12): true only for the FIRST claim of an update_id.
export async function claimReply(db: Database, updateId: number): Promise<boolean> {
  const rows = await db
    .insert(replies)
    .values({ updateId })
    .onConflictDoNothing()
    .returning({ updateId: replies.updateId })
  return rows.length > 0
}
