import { Inngest, EventSchemas } from 'inngest'

// Typed event map. Dedup happens at send time via the event `id`
// (keyed on Telegram update_id — architecture D7).
type Events = {
  'telegram/message.received': {
    data: {
      updateId: number
      messageId: number
      chatId: string
      chatType: string
      fromId: number | null
      // Sender's Telegram profile name/handle, so ordinary group activity captures a
      // display name (previously only join/leave events did → members showed as raw ids).
      fromFirstName?: string | null
      fromLastName?: string | null
      fromUsername?: string | null
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

// The inbound Telegram message payload — exported so the ingest handler can be invoked
// directly in a test with a synthetic event (end-to-end wiring coverage).
export type TelegramMessageData = Events['telegram/message.received']['data']

export const inngest = new Inngest({
  id: 'baumy',
  schemas: new EventSchemas().fromRecord<Events>(),
})
