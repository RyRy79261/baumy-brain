// Deterministic pre-filter (task-graph I2). Drops obvious noise BEFORE any paid
// LLM call — the primary cost lever. HIGH-PRECISION only: never drop a message
// that could be memory-worthy ("bins fri", "code 4821"). Pure.

const PURE_NOISE =
  /^\s*(ok|okay|k|lol|lmao+|ha(ha)+|hah|nice|cool|thx|thanks|ty|yep|yeah|yup|nope|no|yes|same|true|fair|👍|🙏|😂|❤️?|👌|🔥|💯)\s*[.!?]*\s*$/iu

export interface PrefilterResult {
  keep: boolean
  reason: 'command' | 'candidate' | 'empty' | 'noise'
}

export function prefilter(text: string | null | undefined): PrefilterResult {
  if (!text || !text.trim()) return { keep: false, reason: 'empty' }
  const t = text.trim()
  if (t.startsWith('/')) return { keep: true, reason: 'command' } // bot commands always handled
  if (PURE_NOISE.test(t)) return { keep: false, reason: 'noise' }
  // Punctuation / symbol / emoji-only messages carry no house info.
  if (!/[\p{L}\p{N}]/u.test(t)) return { keep: false, reason: 'noise' }
  return { keep: true, reason: 'candidate' }
}
