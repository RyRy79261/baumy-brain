import { GrammyError } from 'grammy'
import { eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'
import { sendToHouse } from '@/lib/telegram/client'
import { resolveHouseIds } from '@/lib/identity/house'
import { writeAudit } from '@/lib/audit'

// The new -100… supergroup id Telegram hands back when you send to a STALE (pre-upgrade) group id:
// HTTP 400 "group chat was upgraded to a supergroup chat", with parameters.migrate_to_chat_id set to
// the new id (docs/spec/telegram.md D9). Anything else is a real error and must propagate.
function migrateTargetFrom(e: unknown): string | null {
  if (e instanceof GrammyError && e.error_code === 400 && e.parameters?.migrate_to_chat_id != null) {
    return String(e.parameters.migrate_to_chat_id)
  }
  return null
}

// Proactive house send that SELF-HEALS a group→supergroup migration. It resolves the CURRENT live
// transport id in code (never an LLM/message-supplied id — the fixed-destination invariant holds),
// sends, and on the stale-id 400 persists the new id as live_chat_id + retries ONCE against it. The
// SCOPE id (memory key) is never touched, so history is preserved. Used by the reminder/digest paths
// — the proactive sends that can outlive a migration (an inbound reply already lands on the live id,
// since the message wouldn't have been heard otherwise). A non-migration failure propagates so the
// caller's exactly-once release/retry (reminders.md) still runs.
export async function sendToHouseResilient(db: Database, text: string, opts?: { silent?: boolean }): Promise<void> {
  // Resolve the live transport id AND the reminders topic in one read; both are code-resolved config
  // (never LLM/message-supplied), so a reminder lands in the house's "notification channel" topic.
  const { sendId, reminderThreadId } = await resolveHouseIds(db)
  const sendOpts = { ...opts, threadId: reminderThreadId ?? undefined }
  try {
    await sendToHouse(sendId, text, sendOpts)
  } catch (e) {
    const newId = migrateTargetFrom(e)
    if (!newId || newId === sendId) throw e
    // Converge the transport id (scope untouched) so every later send goes straight to the supergroup.
    await db
      .update(houseConfig)
      .set({ liveChatId: newId, migratedFromChatId: sendId, updatedAt: new Date() })
      .where(eq(houseConfig.id, true))
    await writeAudit(db, 'house.migrated', null, null, { from: sendId, to: newId, via: 'send-400' }).catch(() => {})
    await sendToHouse(newId, text, sendOpts) // retry once against the new id (same topic)
  }
}
