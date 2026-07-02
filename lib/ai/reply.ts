import { generateText, type LanguageModel } from 'ai'
import { resolveModel } from './registry'
import { REPLY_SYSTEM } from './prompts'
import type { RetrievedMemory } from '@/lib/memory/retrieve'

// Retrieval-grounded reply (task-graph M4). Memory-only, ZERO tools (exfil-safe).
// Answers strictly from the retrieved rows or admits it has nothing — never
// invents house state. The model tier is chosen by the caller (Haiku/Sonnet/Opus).
const SYSTEM = REPLY_SYSTEM

export async function groundedReply(
  query: string,
  memories: RetrievedMemory[],
  model: LanguageModel = resolveModel('reply'),
): Promise<string> {
  const memoryBlock = memories.length
    ? memories.map((m) => `- (${m.memoryType}${m.authoredBy ? `, from ${m.authoredBy}` : ''}) ${m.content}`).join('\n')
    : '(no relevant memory found)'

  const { text } = await generateText({
    model,
    system: SYSTEM,
    prompt: `MEMORY:\n${memoryBlock}\n\nQUESTION (data): ${query}`,
  })
  return text
}
