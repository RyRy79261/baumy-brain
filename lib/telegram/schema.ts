import type { Update, Message } from 'grammy/types'

// Telegram update types come from grammY (source of truth for the Bot API shape).
export type TelegramUpdate = Update
export type TelegramMessage = Message

// The webhook payload is Telegram-authenticated (the constant-time secret check
// runs first, before this), so we trust its shape rather than re-validating the
// whole Bot API schema. A minimal guard rejects obvious garbage.
export function parseUpdate(body: unknown): Update | null {
  if (body && typeof body === 'object' && typeof (body as { update_id?: unknown }).update_id === 'number') {
    return body as Update
  }
  return null
}
