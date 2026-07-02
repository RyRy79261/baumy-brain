import { eq, sql } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { telegramChats, members, memoryItems, memoryEmbeddings, replies } from '@/db/schema'
import { embed, EMBED_MODEL } from '@/lib/ai/embed'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { encryptSecret } from '@/lib/core/crypto'
import type { Trust } from '@/lib/core/origin'

// Consolidation (memory Phase 5): a new item this cosine-close to an existing active
// one is treated as a restatement, not a new memory. Near-verbatim only — distinct
// facts that merely read alike ("rent due friday" vs "…monday") sit well below this.
const DEDUP_THRESHOLD = 0.97

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

  // Suppress a near-verbatim restatement: bump the original's salience/recency and
  // return it, instead of storing a duplicate. Skipped for secure items — an
  // unchanged descriptor can mask a CHANGED secret, and the facts layer owns secret
  // supersede (memory-core #39). Skipped for quarantined (forwarded/bot) input so a
  // planted note can never suppress — and never bump the salience of — a real fact.
  if (!sens.isSecure && input.trustLevel !== 'quarantined') {
    const dupId = await findDuplicate(db, input.groupId, vector)
    if (dupId) {
      await db
        .update(memoryItems)
        .set({
          salience: sql`least(1.0, ${memoryItems.salience} + 0.1)`,
          accessCount: sql`${memoryItems.accessCount} + 1`,
          lastAccessedAt: new Date(),
        })
        .where(eq(memoryItems.id, dupId))
      return dupId
    }
  }

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

// The nearest active, non-secure item in the group (current embedding model); its id
// iff it is within DEDUP_THRESHOLD cosine of the incoming vector, else null.
async function findDuplicate(db: Database, groupId: string, vector: number[]): Promise<string | null> {
  const v = `[${vector.join(',')}]`
  const res = await db.execute(sql`
    SELECT mi.id AS id, 1 - (me.embedding <=> ${v}::vector) AS sim
    FROM baumy_memory_items mi
    JOIN baumy_memory_embeddings me ON me.memory_item_id = mi.id
    WHERE mi.group_id = ${groupId}
      AND mi.is_active = true
      AND mi.is_secure = false
      AND mi.trust_level <> 'quarantined'
      AND me.model = ${EMBED_MODEL}
    ORDER BY me.embedding <=> ${v}::vector
    LIMIT 1`)
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
  return rows.length && Number(rows[0].sim) >= DEDUP_THRESHOLD ? String(rows[0].id) : null
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
