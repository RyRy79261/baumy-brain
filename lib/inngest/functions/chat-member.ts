import { eq } from 'drizzle-orm'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { houseConfig } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { parseMyChatMember, upsertMember } from '@/lib/identity/roster'

// Owner = whoever invited the bot (decision OWNER). Captured from the
// my_chat_member "added" transition (Telegram-authenticated `from.id`);
// BAUMY_OWNER_ID env overrides. Never derived from message text.
export const handleMyChatMember = inngest.createFunction(
  { id: 'handle-my-chat-member' },
  { event: 'telegram/my_chat_member' },
  async ({ event, step }) => {
    return step.run('capture', async () => {
      const { botAdded, inviterId, chatId } = parseMyChatMember(event.data.raw)
      if (!botAdded || !chatId) return { ignored: true }

      const houseChatId = process.env.BAUMY_HOUSE_CHAT_ID ?? ''
      if (houseChatId && chatId !== houseChatId) return { ignored: 'not-house' }

      const db = createHttpDb()
      await ensureRegistered(db, chatId, inviterId)
      if (inviterId != null) {
        const override = process.env.BAUMY_OWNER_ID
        const ownerId = override && override !== '' ? override : String(inviterId)
        await upsertMember(db, chatId, ownerId, null, 'owner')
      }
      await db.update(houseConfig).set({ houseGroupChatId: chatId }).where(eq(houseConfig.id, true))
      return { owner: inviterId, chatId }
    })
  },
)
