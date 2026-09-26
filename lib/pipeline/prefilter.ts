// Deterministic pre-filter (task-graph I2). Drops obvious noise BEFORE any paid
// LLM call — the primary cost lever. HIGH-PRECISION only: never drop a message
// that could be memory-worthy ("bins fri", "code 4821"). Pure.

const PURE_NOISE =
  /^\s*(ok|okay|k|lol|lmao+|ha(ha)+|hah|nice|cool|thx|thanks|ty|yep|yeah|yup|nope|no|yes|same|true|fair|👍|🙏|😂|❤️?|👌|🔥|💯)\s*[.!?]*\s*$/iu

export interface PrefilterResult {
  keep: boolean
  reason: 'command' | 'candidate' | 'empty' | 'noise' | 'answer'
}

// Who the message is for, known BEFORE the noise drop (C7). "yes" / "ok" / 👍 is noise in the
// group chatter, but it is an ANSWER when it replies to Baumy (or is in the ask-Baumy topic, or is
// @-addressed) or arrives in a member's 1:1 DM — Baumy asks things ("want me to remind the
// house?"), and dropping the reply made those questions unanswerable.
export interface PrefilterContext {
  directed?: boolean
  dm?: boolean
}

export function prefilter(text: string | null | undefined, ctx: PrefilterContext = {}): PrefilterResult {
  if (!text || !text.trim()) return { keep: false, reason: 'empty' }
  const t = text.trim()
  if (t.startsWith('/')) return { keep: true, reason: 'command' } // bot commands always handled
  if (ctx.directed || ctx.dm) return { keep: true, reason: 'answer' } // addressed to Baumy → never noise
  if (PURE_NOISE.test(t)) return { keep: false, reason: 'noise' }
  // Punctuation / symbol / emoji-only messages carry no house info.
  if (!/[\p{L}\p{N}]/u.test(t)) return { keep: false, reason: 'noise' }
  return { keep: true, reason: 'candidate' }
}
