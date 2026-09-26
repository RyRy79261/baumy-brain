import { eq, sql } from 'drizzle-orm'
import { createHttpDb, type Database } from '@/db/client'
import { telegramChats, members, memoryItems, memoryEmbeddings, replies } from '@/db/schema'
import { embed, EMBED_MODEL } from '@/lib/ai/embed'
import { scanSensitivity } from '@/lib/core/sensitivity'
import { encryptSecret } from '@/lib/core/crypto'
import { isRelayed, type Trust } from '@/lib/core/origin'
import { now as clockNow } from '@/lib/core/clock'

// Consolidation (memory Phase 5): a new item this cosine-close to an existing active
// one is treated as a restatement, not a new memory. Near-verbatim only — distinct
// facts that merely read alike ("bin day friday" vs "…monday") sit well below this.
const DEDUP_THRESHOLD = 0.97
// …and only a restatement by the SAME author within this window (F9). Short first-person lines ("I'm
// away this weekend") are identical across people and weeks: keyed on cosine alone, Chloe's statement
// folded onto Marco's month-old note — attributed to him and dated then.
const DEDUP_WINDOW_HOURS = 24

// Minimal registration so FK-bound memory writes succeed + display-name capture.
// Idempotent: registers the member by id and, when the message carries a profile name,
// backfills/refreshes their display name so grounding + reflection attribute a NAME
// rather than a raw Telegram id ("numbers not faces"). Never touches role/isActive
// (that's the roster's job) — a plain message only fills in the name.
export async function ensureRegistered(
  db: Database,
  groupId: string,
  fromId: number | null,
  fromName?: string | null,
): Promise<void> {
  await db.insert(telegramChats).values({ chatId: groupId, kind: 'house_group', isPrimary: true }).onConflictDoNothing()
  if (fromId == null) return
  const id = String(fromId)
  if (fromName) {
    await db
      .insert(members)
      .values({ telegramUserId: id, groupId, displayName: fromName })
      .onConflictDoUpdate({ target: members.telegramUserId, set: { displayName: fromName } })
  } else {
    await db.insert(members).values({ telegramUserId: id, groupId }).onConflictDoNothing()
  }
}

export interface CaptureInput {
  groupId: string
  content: string
  memoryType: string
  authoredBy: string | null
  trustLevel: Trust
  /** A member-forwarded message (trust 'forwarded'): who forwarded it — never its author (D4). */
  forwardedBy?: string | null
  /** How much this matters (0..1) — a RANKING signal only (memory v2 §5), never a
   *  delete policy. Durable facts score high, chatter low; default 0.5 if unset. */
  salience?: number
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

  // Suppress a near-verbatim restatement by the same person within DEDUP_WINDOW_HOURS: bump the
  // original's salience and return it, instead of storing a duplicate. Skipped for secure items — an
  // unchanged descriptor can mask a CHANGED secret, and the facts layer owns secret
  // supersede (memory-core #39). Skipped for relayed (forwarded/bot) input so a
  // planted note can never suppress — and never bump the salience of — a real fact (and two different
  // forwarded notices, both unattributed, never fold into one).
  if (!sens.isSecure && !isRelayed(input.trustLevel)) {
    const dupId = await findDuplicate(db, input.groupId, vector, input.authoredBy)
    if (dupId) {
      // NOTE: accessCount / lastAccessedAt are write-only for now — bumped here on
      // consolidation but read by nothing (recency composition uses createdAt), and
      // lastAccessedAt is a misnomer (it tracks last consolidation, not a read). Kept
      // as substrate for a future recency signal; dropping them needs a migration.
      await db
        .update(memoryItems)
        .set({
          salience: sql`least(1.0, ${memoryItems.salience} + 0.1)`,
          accessCount: sql`${memoryItems.accessCount} + 1`,
          lastAccessedAt: clockNow(),
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
      forwardedBy: input.trustLevel === 'forwarded' ? (input.forwardedBy ?? null) : null,
      isSecure: sens.isSecure,
      contentEncrypted,
      salience: Math.min(1, Math.max(0, input.salience ?? 0.5)),
      // Explicit, not the column default: created_at is when it was SAID — the reply renders it as the
      // note's date (T1), and a Postgres defaultNow() is unreachable from a simulated clock.
      createdAt: clockNow(),
    })
    .returning({ id: memoryItems.id })

  await db.insert(memoryEmbeddings).values({ memoryItemId: item.id, model: EMBED_MODEL, embedding: vector })
  return item.id
}

// The nearest active, non-secure item in the group (current embedding model) by the SAME author
// (an anonymous post only matches another anonymous one) said within DEDUP_WINDOW_HOURS; its id iff it
// is within DEDUP_THRESHOLD cosine of the incoming vector, else null.
async function findDuplicate(db: Database, groupId: string, vector: number[], authoredBy: string | null): Promise<string | null> {
  const v = `[${vector.join(',')}]`
  const since = new Date(clockNow().getTime() - DEDUP_WINDOW_HOURS * 3_600_000)
  const res = await db.execute(sql`
    SELECT mi.id AS id, 1 - (me.embedding <=> ${v}::vector) AS sim
    FROM baumy_memory_items mi
    JOIN baumy_memory_embeddings me ON me.memory_item_id = mi.id
    WHERE mi.group_id = ${groupId}
      AND mi.is_active = true
      AND mi.is_secure = false
      AND mi.trust_level NOT IN ('quarantined', 'forwarded')
      AND mi.authored_by IS NOT DISTINCT FROM ${authoredBy}
      AND mi.created_at >= ${since.toISOString()}
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

// Release a claim so a transient failure can be retried. The claim autocommits (neon-http)
// and the send is fallible with no sweeper backstop, so without this a single Telegram/LLM
// hiccup permanently drops the reply. Best-effort delete of the claim row.
export async function releaseReply(db: Database, updateId: number): Promise<void> {
  await db.delete(replies).where(eq(replies.updateId, updateId))
}
