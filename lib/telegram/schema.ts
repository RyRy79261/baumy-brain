import { z } from 'zod'

const tgUser = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  username: z.string().optional(),
})

const tgChat = z.object({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
})

const tgMessage = z
  .object({
    message_id: z.number(),
    date: z.number(),
    chat: tgChat,
    from: tgUser.optional(),
    text: z.string().optional(),
    // service fields used for member auto-discovery + group migration
    new_chat_members: z.array(tgUser).optional(),
    left_chat_member: tgUser.optional(),
    migrate_to_chat_id: z.number().optional(),
    migrate_from_chat_id: z.number().optional(),
  })
  .passthrough()

// Minimal update shape; passthrough retains unknown fields for later phases.
export const updateSchema = z
  .object({
    update_id: z.number(),
    message: tgMessage.optional(),
    edited_message: tgMessage.optional(),
    my_chat_member: z.unknown().optional(),
    callback_query: z.unknown().optional(),
  })
  .passthrough()

export type TelegramUpdate = z.infer<typeof updateSchema>
export type TelegramMessage = z.infer<typeof tgMessage>

export function parseUpdate(body: unknown): TelegramUpdate | null {
  const r = updateSchema.safeParse(body)
  return r.success ? r.data : null
}
