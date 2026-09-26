import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Critic repro: Baumy's "I learned it" acknowledgement is a 🧠 reaction (ingest.ts:331, :593), but
// 🧠 is not in the Bot API's allowed ReactionTypeEmoji set. setMessageReaction 400s
// (REACTION_INVALID) and reactToMessage swallows it (client.ts:88-95), so the ack NEVER appears.
// The sandbox outbox records the reaction BEFORE the API call, so no existing test can see this.
const req = createRequire(join(process.cwd(), 'node_modules/grammy/package.json'))
const typesDir = dirname(req.resolve('@grammyjs/types/package.json'))
const dts = readFileSync(join(typesDir, 'message.d.ts'), 'utf8')
const union = dts.match(/interface ReactionTypeEmoji \{[\s\S]*?emoji: ([^;]+);/)![1]

describe('reaction vocabulary vs Bot API', () => {
  it('🧠 (learned-it ack) is NOT an allowed reaction emoji', () => {
    expect(union.includes('"🧠"')).toBe(false)
  })
  it('the other acks Baumy uses are allowed', () => {
    for (const e of ['👀', '👍', '👎', '🔥', '🎉', '🤯']) expect(union.includes(`"${e}"`)).toBe(true)
  })
  it('ingest really does send 🧠 as the learned/remembered ack', () => {
    const src = readFileSync(join(process.cwd(), 'lib/inngest/functions/ingest.ts'), 'utf8')
    expect(src).toMatch(/remembered \? '🧠' : '👀'/)
    expect(src).toMatch(/mut\.op === 'add' \? '🧠' : '👍'/)
  })
})
