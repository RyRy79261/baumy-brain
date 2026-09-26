import type { TelegramMessage } from '@/lib/telegram/schema'

// What of a Telegram message the pipeline reads (docs/spec/chat-understanding-v2.md §8, I4). Pure.
//
// A photo / document / video / voice note may carry a CAPTION — the only words in it. The caption is
// folded into `text` here, at the webhook, so "new bin schedule from the council — bins now go out
// tuesdays" under a photo is read, remembered and answered like any typed message (before, text was
// null and ingest dropped it as 'empty' before triage ever saw it). The media itself is never
// fetched or interpreted: a voice note, sticker, location or contact without a caption carries no
// text and is ignored EXPLICITLY — ingest drops it with reason 'media' (the sender is still
// registered), never mistaking it for an empty message.

export const MEDIA_KINDS = [
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'video_note',
  'sticker',
  'location',
  'venue',
  'contact',
  'poll',
  'dice',
  'story',
  'game',
] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

export interface MessageContent {
  /** The typed text, else the media's caption, else null. */
  text: string | null
  /** The media the message carries (the first kind present), or null for a plain text message. */
  media: MediaKind | null
}

export function messageContent(msg: Pick<TelegramMessage, 'text' | 'caption'> & Partial<Record<MediaKind, unknown>>): MessageContent {
  const media = MEDIA_KINDS.find((k) => msg[k] != null) ?? null
  const text = msg.text ?? msg.caption ?? null
  return { text: text != null && text.trim() ? text : null, media }
}
