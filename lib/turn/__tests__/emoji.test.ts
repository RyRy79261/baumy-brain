import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLANNER_EMOJI, NOTED } from '@/lib/turn/emoji'

// K1: a reaction outside the Bot API's ReactionTypeEmoji union is rejected by Telegram, so it never
// renders. Read the union straight out of the INSTALLED grammY types (the source of truth this repo
// compiles against) and assert every emoji Baumy may react with is in it.
function botApiReactionEmoji(): Set<string> {
  // pnpm keeps @grammyjs/types under .pnpm/@grammyjs+types@<ver>/ — resolve it without relying on
  // hoisting (it is a transitive dependency of grammy, not a direct one).
  const pnpmDir = join(process.cwd(), 'node_modules/.pnpm')
  const pkg = readdirSync(pnpmDir).find((d) => d.startsWith('@grammyjs+types@'))
  if (!pkg) throw new Error('@grammyjs/types not installed')
  const dts = readFileSync(join(pnpmDir, pkg, 'node_modules/@grammyjs/types/message.d.ts'), 'utf8')
  const union = dts.match(/interface ReactionTypeEmoji \{[\s\S]*?emoji: ([^;]+);/)?.[1]
  if (!union) throw new Error('ReactionTypeEmoji union not found in message.d.ts')
  return new Set([...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
}

describe('PLANNER_EMOJI — every reaction Baumy sends is a real Bot API reaction', () => {
  const allowed = botApiReactionEmoji()

  it('parses a non-trivial allow-list (guards the parser itself)', () => {
    expect(allowed.size).toBeGreaterThan(50)
    expect(allowed.has('👍')).toBe(true)
  })

  it('every member is in the ReactionTypeEmoji union', () => {
    for (const e of PLANNER_EMOJI) expect(allowed.has(e), `${e} is not a Bot API reaction`).toBe(true)
  })

  it('the "noted" ack is ✍, and 🧠 (which never rendered) is gone', () => {
    expect(NOTED).toBe('✍')
    expect(allowed.has('🧠')).toBe(false)
    expect(PLANNER_EMOJI as readonly string[]).not.toContain('🧠')
  })

  it('no production source still sends 🧠', () => {
    for (const f of ['lib/inngest/functions/ingest.ts', 'lib/telegram/client.ts']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8')).not.toContain('🧠')
    }
  })
})
