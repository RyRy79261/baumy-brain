import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { facts, memoryItems, messages } from '@/db/schema'
import { cancelUnsentSeries } from '@/lib/reminders/store'
import { now as clockNow } from '@/lib/core/clock'

// EDITS (docs/spec/chat-understanding-v2.md §8, I1). Telegram delivers an edit as a NEW update (new
// update_id, so every update-keyed dedupe passes) carrying the SAME message_id. Run as a fresh message,
// it duplicated everything: a second "⏰ bins out" at the old time, the uncorrected note still
// recallable next to the corrected one, a second reply. The conversation window (baumy_messages) maps
// (chat, message_id) → what the original PRODUCED (lib/turn/window.ts linkProduced), which is what this
// module works from:
//
//   • the original's evidence note is retired BEFORE the edited text is captured (so consolidation can
//     never fold the edit back onto it) — unless another message on record produced the same note (a
//     consolidated repeat), which still says it — and facts the edit restates keep their row, re-pointed
//     at the new note;
//   • a fact only the original stated is soft-retracted (deleted_at, like a forget — it was never true,
//     so it must not live on as "earlier" history), and a fact the edit corrects inherits the retracted
//     row's own parent (the chain skips the typo);
//   • every UNSENT reminder the original set (and any later occurrence of its series) is cancelled; the
//     edited text is then read again and whatever it still asks for is created fresh — "cancel +
//     recreate". A reminder already delivered stays delivered.
//
// Baumy never speaks in words for an edit (lib/turn/plan.ts quietForEdit). An edit of a message it never
// processed (no window row — sent before Baumy joined, or older than the 48h window) is handled as a new
// message, silently.

export interface EditMap {
  /** The original is on record (its window row exists). */
  processed: boolean
  /** Which message this is (the window key) — to tell its own produced note from one another message
   *  on record also produced. */
  key?: { chatId: string; messageId: number }
  memoryItemId: string | null
  factIds: string[]
  reminderIds: string[]
}

/** What the original of an edited message produced — read BEFORE the edit's window upsert. */
export async function lookupEdit(db: Database, k: { chatId: string; messageId: number }): Promise<EditMap> {
  const [row] = await db
    .select({ memoryItemId: messages.producedMemoryItemId, factIds: messages.producedFactIds, reminderIds: messages.producedReminderIds })
    .from(messages)
    .where(and(eq(messages.chatId, k.chatId), eq(messages.messageId, String(k.messageId))))
    .limit(1)
  if (!row) return { processed: false, key: k, memoryItemId: null, factIds: [], reminderIds: [] }
  return { processed: true, key: k, memoryItemId: row.memoryItemId ?? null, factIds: row.factIds ?? [], reminderIds: row.reminderIds ?? [] }
}

/**
 * Withdraw what the original produced that the edited text must not inherit, BEFORE it is re-read: the
 * evidence note (retired — its facts are settled after capture) and the unsent reminders. Scoped to the
 * house; idempotent (a retried step changes nothing twice). Returns what it did, for the log.
 */
export async function withdrawForEdit(db: Database, groupId: string, map: EditMap): Promise<{ noteRetired: boolean; remindersCancelled: string[] }> {
  let noteRetired = false
  // A near-verbatim repeat is CONSOLIDATED onto the earlier message's note (lib/memory/write.ts), so two
  // window rows can name one note. It is retired only when no OTHER message on record produced it: an
  // edit of the repeat must not hide what the first message (never edited) said, and an edit of the first
  // must not hide what the repeat still says.
  const shared =
    map.memoryItemId && map.key
      ? (
          await db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.groupId, groupId),
                eq(messages.producedMemoryItemId, map.memoryItemId),
                sql`NOT (${messages.chatId} = ${map.key.chatId} AND ${messages.messageId} = ${String(map.key.messageId)})`,
              ),
            )
            .limit(1)
        ).length > 0
      : false
  if (map.memoryItemId && !shared) {
    const r = await db
      .update(memoryItems)
      .set({ isActive: false })
      .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, map.memoryItemId), eq(memoryItems.isActive, true)))
      .returning({ id: memoryItems.id })
    noteRetired = r.length > 0
  }
  const remindersCancelled = await cancelUnsentSeries(db, groupId, map.reminderIds)
  return { noteRetired, remindersCancelled }
}

/**
 * Settle the original's facts AFTER the edited text was captured: `produced` = the facts the edit
 * added/updated, `kept` = the ones it restated unchanged (reconcile NOOP), `noteId` = the edit's own
 * evidence note (null when the edit was not captured at all). Returns the ids retracted.
 */
export async function settleEditedFacts(
  db: Database,
  groupId: string,
  original: EditMap,
  edit: { produced: string[]; kept: string[]; noteId: string | null },
): Promise<string[]> {
  const old = original.factIds
  if (!old.length) return []
  const at = clockNow()
  // Restated facts keep their row; their evidence is now the edited message.
  if (edit.kept.length && edit.noteId && original.memoryItemId) {
    await db
      .update(facts)
      .set({ sourceMemoryItemId: edit.noteId })
      .where(and(eq(facts.groupId, groupId), inArray(facts.id, edit.kept), eq(facts.sourceMemoryItemId, original.memoryItemId)))
  }
  // A fact the edit CORRECTED ("friday" → "saturday" supersedes the original's row): its lineage skips
  // the typo — the parent becomes whatever the retracted row itself followed from (or nothing).
  if (edit.produced.length) {
    await db.execute(sql`
      UPDATE baumy_facts n SET derived_from_fact_id = o.derived_from_fact_id
        FROM baumy_facts o
       WHERE n.group_id = ${groupId} AND o.group_id = ${groupId}
         AND n.id IN (${sql.join(edit.produced.map((id) => sql`${id}::uuid`), sql`, `)})
         AND n.derived_from_fact_id = o.id
         AND o.id IN (${sql.join(old.map((id) => sql`${id}::uuid`), sql`, `)})`)
  }
  // Everything else the original stated is retracted: soft-deleted like a forget (never "earlier"
  // history — it was a slip, not a past state). A row someone ELSE has since superseded is left alone.
  const keep = [...edit.produced, ...edit.kept]
  const retracted = await db
    .update(facts)
    .set({ isCurrent: false, deletedAt: at, invalidatedAt: at })
    .where(
      and(
        eq(facts.groupId, groupId),
        inArray(facts.id, old),
        keep.length ? notInArray(facts.id, keep) : undefined,
        isNull(facts.deletedAt),
        sql`(${facts.isCurrent} = true OR ${facts.supersededBy} IN (${sql.join((keep.length ? keep : ['00000000-0000-0000-0000-000000000000']).map((id) => sql`${id}::uuid`), sql`, `)}))`,
      ),
    )
    .returning({ id: facts.id })
  return retracted.map((r) => r.id)
}
