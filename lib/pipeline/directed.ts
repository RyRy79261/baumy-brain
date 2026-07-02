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
