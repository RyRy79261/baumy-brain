import { generateObject, generateText, type LanguageModel } from 'ai'
import { z } from 'zod'
import { resolveModel } from './registry'
import { REPLY_SYSTEM, REPLY_SYSTEM_TEXT } from './prompts'
import type { RetrievedMemory } from '@/lib/memory/retrieve'

// Grounded reply. Memory-only, ZERO tools (exfil-safe). Answers strictly from the
// retrieved rows or admits it has nothing — never invents house state. The model
// ALSO self-assesses whether it needs a stronger model (self-escalation).
const answerSchema = z.object({
  reply: z.string(),
  needsStrongerModel: z.boolean(),
})

function memoryBlock(memories: RetrievedMemory[]): string {
  return memories.length
    ? memories.map((m) => `- (${m.memoryType}${m.authoredBy ? `, from ${m.authoredBy}` : ''}) ${m.content}`).join('\n')
    : '(no relevant memory found)'
}

// Today's date in the house timezone, so the model can resolve relative dates
// ("next week", "this weekend", "tomorrow") — without this it can't answer time-
// relative questions ("what's on next week?") at all.
function houseToday(): string {
  const tz = process.env.BAUMY_TIMEZONE || 'Europe/Berlin'
  const d = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date())
  return `${d} (house time, ${tz})`
}

export async function groundedReply(
  query: string,
  memories: RetrievedMemory[],
  model: LanguageModel = resolveModel('reply'),
): Promise<{ text: string; escalate: boolean }> {
  const prompt = `TODAY is ${houseToday()} — resolve any relative dates in the QUESTION ("next week", "this weekend", "tomorrow") against it, and use it to judge what is upcoming vs already past.\n\nMEMORY:\n${memoryBlock(memories)}\n\nQUESTION (data): ${query}`
  try {
    const { object } = await generateObject({ model, schema: answerSchema, system: REPLY_SYSTEM, prompt })
    return { text: object.reply, escalate: object.needsStrongerModel }
  } catch {
    // A model occasionally malforms the structured object (e.g. wraps it under an
    // extra key) — that must NEVER swallow a user-facing reply. Fall back to plain
    // text with the same grounding; forgo self-escalation for this turn.
    const { text } = await generateText({ model, system: REPLY_SYSTEM_TEXT, prompt })
    return { text: text.trim(), escalate: false }
  }
}

// Self-advising escalation ladder: Haiku → Sonnet → Opus. The triage tier sets the
// STARTING model (quick=Haiku; think/deep=Sonnet, with Opus as the advisor); if a
// model says it needs more brainpower, we bump up one tier (capped at Opus) and
// re-answer over the same grounding.
const LADDER = ['reply', 'assess', 'advisor'] as const // Haiku, Sonnet, Opus

export async function answer(
  query: string,
  memories: RetrievedMemory[],
  startTier: 'quick' | 'think' | 'deep',
): Promise<{ text: string; usedTier: (typeof LADDER)[number] }> {
  let idx = startTier === 'quick' ? 0 : 1 // think/deep start at Sonnet; Opus advises
  let r = await groundedReply(query, memories, resolveModel(LADDER[idx]))
  while (r.escalate && idx < LADDER.length - 1) {
    idx += 1
    r = await groundedReply(query, memories, resolveModel(LADDER[idx]))
  }
  return { text: r.text, usedTier: LADDER[idx] }
}
