import { AsyncLocalStorage } from 'node:async_hooks'

// Outbound capture seam (docs/spec/sandbox-console.md). When a sink is installed, every send in
// lib/telegram/client.ts records into it and returns INSTEAD of calling the Bot API.
//
// This is the sandbox's most important safety property, and the reason it is enforced in the
// transport rather than by the caller: a sandbox physically cannot post to the real house group,
// even if it is pointed at production config, even if a code path forgets it is in a sandbox. The
// survey's banal-but-common failure is a test bed that inherits TELEGRAM_BOT_TOKEN and
// BAUMY_HOUSE_CHAT_ID and messages real people; installing the sink closes that off at the exit.
//
// AsyncLocalStorage for the same reason as the clock: a module global would capture a concurrent
// real request's sends.

export interface OutboundMessage {
  kind: 'message' | 'confirm-card' | 'dm' | 'reaction' | 'edit' | 'callback-answer'
  chatId: string
  text: string | null
  /** Set for reactions ('👀', '✍', null = cleared) and for confirm cards (the action id). */
  meta?: string | null
  /** For a message / confirm card sent as a Telegram reply: the message_id it replies to (C11). */
  replyTo?: number
  /** For a message / confirm card: the synthetic Telegram message_id the sandbox gave it (a real send
   *  gets Telegram's). Lets the conversation window key Baumy's own turns (and a test reply to one). */
  messageId?: number
  at: Date
}

// Synthetic message ids for captured sends: process-wide and monotonic (a sink lives for ONE sandbox
// call, so a per-sink counter would reuse ids across turns), and far above any id a sandbox gives an
// inbound message.
export const SANDBOX_SENT_ID_BASE = 900_000_000
let sentSeq = 0

const sink = new AsyncLocalStorage<OutboundMessage[]>()

/** The sandbox's stand-in for Telegram's group membership (getChatMember): a status ('member',
 *  'administrator', 'left', …) or null when the user is unknown there. Installed with the sink. */
export type ChatMemberDirectory = (chatId: string, userId: number) => string | null
const directory = new AsyncLocalStorage<ChatMemberDirectory | null>()

/** The installed sandbox membership directory — only ever consulted while capturing (no network). */
export const sandboxChatMember = (chatId: string, userId: number): string | null => directory.getStore()?.(chatId, userId) ?? null

/** Installed sink, or undefined when we are talking to the real Bot API. */
export const outboundSink = (): OutboundMessage[] | undefined => sink.getStore()

/** True while sends are being captured rather than delivered. */
export const isCapturing = (): boolean => sink.getStore() !== undefined

/** Capture `m` when a sink is installed: returns the recorded entry (a sent message gets a synthetic
 *  message id), or null when we are talking to the real Bot API. */
export function record(m: Omit<OutboundMessage, 'at' | 'messageId'>, at: Date): OutboundMessage | null {
  const s = sink.getStore()
  if (!s) return null
  const entry: OutboundMessage = { ...m, at, ...(m.kind === 'message' || m.kind === 'confirm-card' ? { messageId: SANDBOX_SENT_ID_BASE + ++sentSeq } : {}) }
  s.push(entry)
  return entry
}

/**
 * Run `fn` with outbound capture installed. Returns whatever Baumy tried to say, in order,
 * alongside the function's own result. Nothing reaches Telegram.
 */
export async function captureOutbound<T>(fn: () => Promise<T>, opts: { chatMembers?: ChatMemberDirectory } = {}): Promise<{ result: T; sent: OutboundMessage[] }> {
  const box: OutboundMessage[] = []
  const result = await sink.run(box, () => directory.run(opts.chatMembers ?? null, fn))
  return { result, sent: box }
}
