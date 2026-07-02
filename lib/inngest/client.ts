import { Inngest, EventSchemas } from 'inngest'

// Typed event map. Dedup happens at send time via the event `id`
// (keyed on Telegram update_id — architecture D7). More events land in
// later phases (reminders, scheduled tasks, deliberation).
type Events = {
  'telegram/message.received': {
    data: {
      updateId: number
      chatId: string
      chatType: string
      fromId: number | null
      text: string | null
      isBot: boolean
      isForwarded: boolean
      replyToBot: boolean
    }
  }
  'telegram/callback.received': {
    data: {
      updateId: number
      callbackId: string
      fromId: number
      chatId: string
      messageId: number | null
      data: string
    }
  }
  'reminder/arm.due': { data: { reminderId: string } }
  'reminder/cancelled': { data: { reminderId: string } }
  'telegram/my_chat_member': { data: { updateId: number; raw: unknown } }
  'telegram/chat_member': { data: { updateId: number; raw: unknown } }
}

export const inngest = new Inngest({
  id: 'baumy',
  schemas: new EventSchemas().fromRecord<Events>(),
})
