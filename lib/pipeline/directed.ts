// Is a group message DIRECTED at Baumy (product.md #82)? A directed message —
// an @mention of the bot's REAL username, addressing it by its short name, or a
// reply to one of its messages — is ALWAYS answered; an undirected message only
// gets the policy-gated auto-answer. `botUsername` is Baumy's actual Telegram
// username (from getMe), so it knows its own name instead of guessing.
export function isDirectedAtBaumy(text: string | null, replyToBaumy: boolean, botUsername: string): boolean {
  if (replyToBaumy) return true
  const t = (text ?? '').toLowerCase()
  const uname = (botUsername ?? '').toLowerCase()
  if (!uname) return false
  if (t.includes(`@${uname}`)) return true // exact @mention, e.g. "@baumy_bot"
  // Also its short name (username minus a trailing "bot"/"_bot") as a whole word,
  // so "hey baumy" counts — but not substrings like "baumyish".
  const short = uname.replace(/_?bot$/, '')
  if (!short) return false
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9_@])${esc}(?![a-z0-9_])`, 'i').test(t)
}

// The replied-to message, as the webhook forwards it (Telegram-authenticated transport fields).
export interface ReplyToMessage {
  fromId: number | null
  isBot: boolean
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
// stored note reads "Zuzka is staying in my room", not "@baumy_bot Zuzka is staying…", and the
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
