import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { resolveModel } from './registry'
import { REPLY_SYSTEM } from './prompts'
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

export async function groundedReply(
  query: string,
  memories: RetrievedMemory[],
  model: LanguageModel = resolveModel('reply'),
): Promise<{ text: string; escalate: boolean }> {
  const { object } = await generateObject({
    model,
    schema: answerSchema,
    system: REPLY_SYSTEM,
    prompt: `MEMORY:\n${memoryBlock(memories)}\n\nQUESTION (data): ${query}`,
  })
  return { text: object.reply, escalate: object.needsStrongerModel }
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
