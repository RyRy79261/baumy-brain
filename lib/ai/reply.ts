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
  answered: z.boolean(), // did it actually answer from memory, or admit a miss?
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
): Promise<{ text: string; escalate: boolean; answered: boolean }> {
  const prompt = `TODAY is ${houseToday()} — resolve any relative dates in the QUESTION ("next week", "this weekend", "tomorrow") against it, and use it to judge what is upcoming vs already past.\n\nMEMORY:\n${memoryBlock(memories)}\n\nQUESTION (data): ${query}`
  try {
    const { object } = await generateObject({ model, schema: answerSchema, system: REPLY_SYSTEM, prompt })
    return { text: object.reply, escalate: object.needsStrongerModel, answered: object.answered }
  } catch {
    // A model occasionally malforms the structured object (e.g. wraps it under an
    // extra key) — that must NEVER swallow a user-facing reply. Fall back to plain
    // text with the same grounding; forgo self-escalation. Treat as answered (we got
    // words — send them; never downgrade a malformed-object fallback to a 👎 miss).
    const { text } = await generateText({ model, system: REPLY_SYSTEM_TEXT, prompt })
    return { text: text.trim(), escalate: false, answered: true }
  }
}

// Self-advising escalation ladder: Sonnet → Opus. EVERY reply starts on Sonnet (the
// primary reasoning model); if a model signals it needs more brainpower, we bump to
// the Opus advisor for that turn and re-answer over the same grounding. Haiku is NOT
// on this ladder — it only does upstream triage/routing. The triage tier still drives
// retrieval DEPTH upstream (deep = expansion + broad search), not the reply model.
const LADDER = ['reply', 'advisor'] as const // Sonnet → Opus

export async function answer(
  query: string,
  memories: RetrievedMemory[],
): Promise<{ text: string; usedTier: (typeof LADDER)[number]; answered: boolean }> {
  let idx = 0 // always start at Sonnet
  let r = await groundedReply(query, memories, resolveModel(LADDER[idx]))
  while (r.escalate && idx < LADDER.length - 1) {
    idx += 1
    r = await groundedReply(query, memories, resolveModel(LADDER[idx]))
  }
  return { text: r.text, usedTier: LADDER[idx], answered: r.answered }
}
