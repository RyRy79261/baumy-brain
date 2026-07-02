import { inngest } from '@/lib/inngest/client'
import { createHttpDb } from '@/db/client'
import { loadRoster } from '@/lib/identity/roster'
import { resolvePendingAction } from '@/lib/confirm/store'
import { createReminder } from '@/lib/reminders/store'
import { answerCallback, editMessageText } from '@/lib/telegram/client'

// Deterministic confirm handler (security Stage D / B4). A callback_query is a
// Telegram-authenticated button press; only an ACTIVE member/owner from.id may
// resolve a pending action. The press is the injection wall — group text can
// propose a privileged action but only a human tap executes it.
export const handleCallbackQuery = inngest.createFunction(
  { id: 'handle-callback-query', retries: 2 },
  { event: 'telegram/callback.received' },
  async ({ event }) => {
    const { callbackId, fromId, chatId, messageId, data } = event.data
    const db = createHttpDb()

    // Fail closed: only an active member/owner may confirm.
    const roster = await loadRoster(db)
    if (!roster.isMember(fromId)) {
      await answerCallback(callbackId, 'Not authorized.')
      return { ignored: 'not-member' }
    }

    const [verb, id] = data.split(':')
    if ((verb !== 'c' && verb !== 'x') || !id) {
      await answerCallback(callbackId)
      return { ignored: 'bad-data' }
    }

    if (verb === 'x') {
      await resolvePendingAction(db, id, 'cancelled')
      await answerCallback(callbackId, 'Cancelled')
      if (messageId) await editMessageText(chatId, messageId, '✖️ Cancelled.')
      return { cancelled: id }
    }

    const action = await resolvePendingAction(db, id, 'confirmed')
    if (!action) {
      await answerCallback(callbackId, 'This already expired or was handled.')
      return { ignored: 'not-pending' }
    }

    if (action.actionType === 'reminder.create') {
      const p = action.payload as {
        deliverChatId: string
        content: string
        fireAt: string
        createdBy: string | null
        resolvedLocal: string
      }
      const rid = await createReminder(db, {
        groupId: chatId,
        deliverChatId: p.deliverChatId,
        content: p.content,
        fireAt: new Date(p.fireAt),
        createdBy: p.createdBy,
      })
      await inngest.send({ id: `reminder-arm:${rid}`, name: 'reminder/arm.due', data: { reminderId: rid } })
      await answerCallback(callbackId, 'Reminder set')
      if (messageId) await editMessageText(chatId, messageId, `✅ Reminder set — "${p.content}" on ${p.resolvedLocal}.`)
      return { confirmed: id, reminderId: rid }
    }

    await answerCallback(callbackId, 'Done')
    return { confirmed: id, actionType: action.actionType }
  },
)
