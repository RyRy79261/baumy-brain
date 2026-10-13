// Deterministic acks for list ops — CODE composes these, not the model. A disposed action
// (item added / checked off / list rendered) is data, so the ack is a fixed string, never an
// LLM paraphrase that could drift or hallucinate an item. Kept in Baumy's voice all the same:
// normal sentence case, dry, the odd cat emoji, PLAIN TEXT (Telegram renders it verbatim — no
// markdown). See docs/spec/shopping-list.md; voice rules mirror lib/ai/prompts.ts PERSONA.

// ["a"] → "a"; ["a","b"] → "a and b"; ["a","b","c"] → "a, b and c".
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function quoted(items: string[]): string {
  return joinAnd(items.map((i) => `"${i}"`))
}

// Ack for an add: report what went on, note anything already there, and the new open count.
export function addAck(added: string[], already: string[], openTotal: number): string {
  const tail = ` — ${openTotal} on the list now.`
  if (added.length && already.length) {
    const were = already.length === 1 ? 'was' : 'were'
    return `Added ${joinAnd(added)} (${joinAnd(already)} ${were} already on there)${tail}`
  }
  if (added.length) return `Added ${joinAnd(added)}${tail} 🐈‍⬛`
  if (already.length) {
    const be = already.length === 1 ? "'s" : ' are'
    return `${joinAnd(already)}${be} already on the list — nothing new to add. 😼`
  }
  return `Nothing to add there. 😼`
}

// Ack for a check-off: what got ticked, anything that wasn't on the list, and what's left.
export function checkoffAck(checkedOff: string[], notFound: string[], remaining: string[]): string {
  let left: string
  if (remaining.length === 0) left = ` That clears the list. 🐈‍⬛`
  else if (remaining.length <= 6) left = ` ${remaining.length} left: ${joinAnd(remaining)}.`
  else left = ` ${remaining.length} left.`

  if (checkedOff.length && notFound.length) {
    return `Checked off ${joinAnd(checkedOff)}. Couldn't find ${quoted(notFound)} on the list though.${left}`
  }
  if (checkedOff.length) return `Checked off ${joinAnd(checkedOff)}.${left}`
  if (notFound.length) return `Couldn't find ${quoted(notFound)} on the list — nothing to check off. 😼`
  return `Nothing to check off there. 😼`
}

// "N left: a, b." — the tail of a check-off / remove / rename ack.
function leftTail(remaining: string[]): string {
  if (remaining.length === 0) return ` The list's empty now. 🐈‍⬛`
  if (remaining.length <= 6) return ` ${remaining.length} left: ${joinAnd(remaining)}.`
  return ` ${remaining.length} left.`
}

// Ack for a remove (off the list WITHOUT being bought — issue #23): what came off, what wasn't on it.
export function removeAck(removed: string[], notFound: string[], remaining: string[]): string {
  const left = leftTail(remaining)
  if (removed.length && notFound.length) return `Took ${joinAnd(removed)} off the list. Couldn't find ${quoted(notFound)} on it though.${left}`
  if (removed.length) return `Took ${joinAnd(removed)} off the list.${left}`
  if (notFound.length) return `Couldn't find ${quoted(notFound)} on the list — nothing taken off. 😼`
  return `Nothing to take off there. 😼`
}

// Ack for a rename (issue #23): each change, a merge said as such, and any name not on the list.
export function renameAck(renamed: { from: string; to: string; merged: boolean }[], notFound: string[], remaining: string[]): string {
  const parts = renamed.map((r) =>
    r.merged ? `"${r.to}" was already on the list, so I took "${r.from}" off.` : `Changed "${r.from}" to "${r.to}".`,
  )
  if (notFound.length) {
    parts.push(renamed.length ? `Couldn't find ${quoted(notFound)} on the list though.` : `Couldn't find ${quoted(notFound)} on the list — nothing changed. 😼`)
  }
  if (!renamed.length) return parts.join(' ') || `Nothing to change there. 😼`
  return `${parts.join(' ')}${leftTail(remaining)}`
}

// Render the current open list (a query reply). Plain text, one bullet per item.
export function renderList(openItems: string[]): string {
  if (openItems.length === 0) return `The shopping list's empty — nothing on it right now. 🐈‍⬛`
  const head = `Shopping list — ${openItems.length} open:`
  return `${head}\n${openItems.map((i) => `• ${i}`).join('\n')}`
}
