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
    }
  }
  'reminder/arm.due': { data: { reminderId: string } }
  'reminder/cancelled': { data: { reminderId: string } }
}

export const inngest = new Inngest({
  id: 'baumy',
  schemas: new EventSchemas().fromRecord<Events>(),
})
