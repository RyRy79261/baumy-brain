// Is a group message DIRECTED at Baumy (product.md #82, chat-understanding-v2 §1)? `botUsername`
// is Baumy's actual Telegram username (from getMe), so it knows its own name instead of guessing.
// Directedness changes VERBOSITY only (the planner answers instead of reacting) — never trust.
export type DirectedWhy = 'mention' | 'reply_to_baumy' | 'console_topic' | 'dm' | 'name'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Words that make "Baumy …" at the start of a message a sentence ABOUT Baumy rather than one TO it
// ("Baumy is annoying", "baumy keeps pinging"). Only applied when the message is not a question —
// "baumy is it bin day?" is still addressed to it.
const THIRD_PERSON = /^\s+(?:is|was|has|had|keeps|kept|isn't|wasn't|doesn't|didn't|never|always|just|seems|sucks|said|says|should|shouldn't)\b/i
const OPENERS = '(?:hey|hi|hello|hiya|yo|oi|ok|okay|so|and|also|dear|morning|evening|thanks|thank you|thx|ty|cheers)'

// The short name ("baumy" for @baumy_bot) used as a VOCATIVE (C10): at the start of the message
// ("Baumy, …", "hey baumy …") or closing it after punctuation or a thanks-word ("…, baumy?",
// "thanks baumy"). A mid-sentence mention ("Marco, ask baumy, it knows"), a possessive ("Baumy's
// reminders are annoying") or a bare trailing name ("did you ask baumy?", "is anyone else annoyed by
// baumy?") is talk ABOUT Baumy, not to it. Those stay undirected: the classifier's `asksBaumy` can
// still route a genuine unaddressed ask ("is it bin day baumy?") through the undirected row.
export function addressesByName(text: string | null, botUsername: string): boolean {
  const uname = (botUsername ?? '').toLowerCase()
  const short = uname.replace(/_?bot$/, '')
  if (!short) return false
  const t = (text ?? '').trim()
  if (!t) return false
  const n = esc(short)
  const start = new RegExp(`^(?:${OPENERS}[\\s,!]+)?${n}(?![\\w'’@])`, 'i').exec(t)
  if (start) {
    const rest = t.slice(start.index + start[0].length)
    if (!THIRD_PERSON.test(rest) || /\?\s*$/.test(t)) return true
  }
  // Closing vocative: only after a comma/punctuation or a thanks-word — a bare "… baumy?" can just as
  // well be the object of the sentence ("did you ask baumy?").
  return new RegExp(`(?:[,;:!.]\\s*|\\b(?:thanks|thank you|thx|ty|cheers|please|pls)\\s+)${n}\\s*[?!.]*\\s*$`, 'i').test(t)
}

// An exact "@username" mention anywhere in the text.
export function mentionsBot(text: string | null, botUsername: string): boolean {
  const uname = (botUsername ?? '').toLowerCase()
  if (!uname) return false
  return new RegExp(`(?<![\\w@])@${esc(uname)}(?![\\w])`, 'i').test(text ?? '')
}

export interface DirectednessInput {
  lane: 'house' | 'member_dm'
  /** The ORIGINAL text (the @mention not yet stripped). */
  text: string | null
  botUsername: string
  replyToBaumy: boolean
  /** The message sits in the house's ask-Baumy topic (/baumyhere). */
  inConsoleTopic: boolean
  /** The message is a reply to ANOTHER housemate's message (not Baumy, not the topic root). */
  repliesToHuman: boolean
}

// Why (if at all) this message is for Baumy — spec §1. A DM is always directed. In the ask-Baumy
// topic a message is directed by default, EXCEPT a reply to another housemate — that is two people
// talking in Baumy's topic, not a question to Baumy (C6).
export function directedness(i: DirectednessInput): { value: boolean; why: DirectedWhy | null } {
  if (i.lane === 'member_dm') return { value: true, why: 'dm' }
  if (i.replyToBaumy) return { value: true, why: 'reply_to_baumy' }
  if (mentionsBot(i.text, i.botUsername)) return { value: true, why: 'mention' }
  if (addressesByName(i.text, i.botUsername)) return { value: true, why: 'name' }
  if (i.inConsoleTopic && !i.repliesToHuman) return { value: true, why: 'console_topic' }
  return { value: false, why: null }
}

// Back-compat boolean view (group text only): an @mention, a vocative short name, or a reply to Baumy.
export function isDirectedAtBaumy(text: string | null, replyToBaumy: boolean, botUsername: string): boolean {
  if (replyToBaumy) return true
  return mentionsBot(text, botUsername) || addressesByName(text, botUsername)
}

// The replied-to message, as the webhook forwards it (Telegram-authenticated transport fields).
export interface ReplyToMessage {
  fromId: number | null
  isBot: boolean
  /** The replied-to message was itself forwarded (its `from` is the forwarder, not the author). */
  isForwarded?: boolean
  text: string | null
  /** The forum topic's creation service message — Telegram sets it as reply_to_message on EVERY
   *  ordinary message in a topic, so it is never a real reply (C9). */
  isTopicRoot: boolean
}

// Is this message a reply to one of BAUMY's messages (C8/C9)? Only when the replied-to author IS
// Baumy's own bot id — not merely any bot (a poll bot, GroupAnonymousBot) — and never the topic-root
// service message. `replyTo === undefined` is an event enqueued by an older webhook that only sent
// the coarse `replyToBot` flag; honour it so in-flight events keep working across the deploy.
export function repliesToBaumy(replyTo: ReplyToMessage | null | undefined, botId: number | null, legacyReplyToBot = false): boolean {
  if (replyTo === undefined) return legacyReplyToBot
  if (!replyTo || replyTo.isTopicRoot) return false
  return botId != null && replyTo.fromId === botId
}

// Strip "@baumy_bot" tokens from the text Baumy reasons over (classify / capture / retrieval), so a
// stored note reads "Zosia is staying in my room", not "@baumy_bot Zosia is staying…", and the
// mention never pollutes lexical/semantic recall (C12). Directedness is decided on the ORIGINAL
// text before this runs. A mention glued to a command ("/bug@baumy_bot") is left alone — commands
// are parsed from the original text. Falls back to the original if nothing else is left.
export function stripBotMention(text: string, botUsername: string): string {
  const uname = (botUsername ?? '').toLowerCase()
  if (!uname) return text
  const esc = uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = text
    .replace(new RegExp(`(?<![\\w@])@${esc}(?![\\w])`, 'gi'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,:;.!–—-]+/, '')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
  return out || text
}
