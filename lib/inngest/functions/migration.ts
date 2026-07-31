import { eq } from 'drizzle-orm'
import { type Database, createHttpDb } from '@/db/client'
import { inngest } from '@/lib/inngest/client'
import { houseConfig } from '@/db/schema'
import { writeAudit } from '@/lib/audit'

// Converge the house TRANSPORT id on a group→supergroup migration (docs/spec/telegram.md D9). The
// ids come from Telegram-authenticated service fields (never message text), but we still bind the
// new id to a chat we ALREADY know as the house (its scope OR current live id) — so an unrelated
// migration can never hijack the destination. The SCOPE (memory key) is never rewritten; only
// live_chat_id moves. Idempotent: re-delivering the same service message is a harmless no-op.
// Exported as a plain function so a test can drive the convergence without the Inngest wrapper.
export async function convergeMigration(
  db: Database,
  oldId: string,
  newId: string,
): Promise<{ migrated?: { from: string; to: string }; ignored?: string; alreadyConverged?: string }> {
  if (!oldId || !newId || oldId === newId) return { ignored: 'noop' }
  const [cfg] = await db
    .select({ scope: houseConfig.houseGroupChatId, live: houseConfig.liveChatId })
    .from(houseConfig)
    .limit(1)
  const scope = cfg?.scope ?? ''
  const live = cfg?.live ?? ''
  if (oldId !== scope && oldId !== live) return { ignored: 'not-house' }
  if (live === newId) return { alreadyConverged: newId } // idempotent replay
  await db
    .update(houseConfig)
    .set({ liveChatId: newId, migratedFromChatId: oldId, updatedAt: new Date() })
    .where(eq(houseConfig.id, true))
  await writeAudit(db, 'house.migrated', null, null, { from: oldId, to: newId, via: 'service-message' })
  return { migrated: { from: oldId, to: newId } }
}

// Fired from the webhook when Telegram delivers a migrate_to_chat_id / migrate_from_chat_id service
// message (app/api/telegram/webhook/route.ts).
export const handleChatMigrated = inngest.createFunction(
  { id: 'handle-chat-migrated' },
  { event: 'telegram/chat_migrated' },
  async ({ event, step }) => step.run('converge', () => convergeMigration(createHttpDb(), event.data.oldId, event.data.newId)),
)
