import { eq } from 'drizzle-orm'
import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { houseConfig } from '@/db/schema'
import { ensureRegistered } from '@/lib/memory/write'
import { parseMyChatMember, parseChatMember, upsertMember, deactivateMember } from '@/lib/identity/roster'
import { getHouseChatId } from '@/lib/identity/house'
import { writeAudit } from '@/lib/audit'

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
      // First invite wins: once a house group is captured, a later add to a
      // DIFFERENT group can't hijack it (env override still forces the match above).
      const [cfg] = await db.select({ existing: houseConfig.houseGroupChatId }).from(houseConfig).limit(1)
      const existing = cfg?.existing ?? ''
      if (!houseChatId && existing !== '' && existing !== chatId) {
        return { ignored: 'house-already-set', existing }
      }

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

// A HOUSEMATE's status changed (chat_member update — distinct from the bot's
// my_chat_member). On leave/kick/ban → deactivate so they immediately lose
// trusted-DM + dashboard access (audit #6). On join → register/reactivate.
export const handleChatMember = inngest.createFunction(
  { id: 'handle-chat-member' },
  { event: 'telegram/chat_member' },
  async ({ event, step }) =>
    step.run('apply', async () => {
      const { userId, status, name, chatId } = parseChatMember(event.data.raw)
      if (!userId || !status) return { ignored: true }
      const db = createHttpDb()

      // House-lane guard (mirror handleMyChatMember): only a status change in the HOUSE
      // group may (de)activate a housemate. Otherwise, if the bot is admin in any second
      // group shared with a housemate, their leaving/joining THERE would silently
      // deactivate/reactivate them here.
      const houseChatId = await getHouseChatId(db)
      if (!houseChatId || chatId !== houseChatId) return { ignored: 'not-house' }

      if (status === 'left' || status === 'kicked' || status === 'banned') {
        await deactivateMember(db, userId)
        await writeAudit(db, 'member.deactivate', null, userId, { reason: status })
        return { deactivated: userId }
      }
      if (status === 'member' || status === 'administrator' || status === 'creator') {
        await upsertMember(db, houseChatId, userId, name)
        return { active: userId }
      }
      return { ignored: status }
    }),
)
