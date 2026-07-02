import { createHttpDb, type Database } from '@/db/client'
import { telegramChats, members, memoryItems, memoryEmbeddings, replies } from '@/db/schema'
import { embed, EMBED_MODEL } from '@/lib/ai/embed'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { encryptSecret } from '@/lib/core/crypto'
import type { Trust } from '@/lib/core/origin'

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

  // Secure values (memory-core #15 / security C8): encrypt the literal app-side,
  // store ONLY a non-secret descriptor as content, and embed the DESCRIPTOR — the
  // plaintext secret never lands in the content column or the vector store.
  const sens = scanSensitivity(input.content)
  const storedContent = sens.isSecure ? sens.descriptor : input.content
  const contentEncrypted = sens.isSecure ? encryptSecret(input.content) : null
  const vector = await embedFn(storedContent)

  const [item] = await db
    .insert(memoryItems)
    .values({
      groupId: input.groupId,
      sourceKind: 'message',
      memoryType: input.memoryType,
      content: storedContent,
      authoredBy: input.authoredBy,
      trustLevel: input.trustLevel,
      isSecure: sens.isSecure,
      contentEncrypted,
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
