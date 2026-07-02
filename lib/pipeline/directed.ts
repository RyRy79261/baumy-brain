// Is a group message DIRECTED at Baumy (product.md #82)? A directed message —
// an @mention, addressing it by name, or a reply to one of Baumy's messages — is
// ALWAYS answered; an undirected message only gets the policy-gated auto-answer.
// Name is `baumy` by default, overridable via BAUMY_BOT_NAME.
export function isDirectedAtBaumy(text: string | null, replyToBaumy: boolean): boolean {
  if (replyToBaumy) return true
  const name = (process.env.BAUMY_BOT_NAME ?? 'baumy').toLowerCase()
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // word-ish boundary so "baumy" / "@baumy" / "hey baumy," match, but not "baumyish"
  return new RegExp(`(?:^|\\W)@?${escaped}(?:\\W|$)`, 'i').test((text ?? '').toLowerCase())
}
