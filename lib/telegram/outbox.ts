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
  /** Set for reactions ('👀', '🧠', null = cleared) and for confirm cards (the action id). */
  meta?: string | null
  at: Date
}

const sink = new AsyncLocalStorage<OutboundMessage[]>()

/** Installed sink, or undefined when we are talking to the real Bot API. */
export const outboundSink = (): OutboundMessage[] | undefined => sink.getStore()

/** True while sends are being captured rather than delivered. */
export const isCapturing = (): boolean => sink.getStore() !== undefined

export function record(m: Omit<OutboundMessage, 'at'>, at: Date): boolean {
  const s = sink.getStore()
  if (!s) return false
  s.push({ ...m, at })
  return true
}

/**
 * Run `fn` with outbound capture installed. Returns whatever Baumy tried to say, in order,
 * alongside the function's own result. Nothing reaches Telegram.
 */
export async function captureOutbound<T>(fn: () => Promise<T>): Promise<{ result: T; sent: OutboundMessage[] }> {
  const box: OutboundMessage[] = []
  const result = await sink.run(box, fn)
  return { result, sent: box }
}
