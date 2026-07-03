import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { resolveModel } from './registry'
import { RERANK_SYSTEM } from './prompts'
import type { RetrievedMemory } from '@/lib/memory/retrieve'

// Deep-tier pointwise re-rank (memory Phase 5). One Sonnet ('assess' tier) pass scores each
// retrieved candidate's relevance to the question, then we reorder by that score —
// a precision boost on top of RRF for the searches that warrant it. Best-effort:
// callers fall back to the fusion order if this throws.
const rerankSchema = z.object({
  scores: z.array(z.object({ i: z.number().int().min(0), score: z.number().min(0).max(1) })),
})

export async function rerank(
  query: string,
  memories: RetrievedMemory[],
  model: LanguageModel = resolveModel('assess'),
): Promise<RetrievedMemory[]> {
  if (memories.length <= 1) return memories
  const items = memories.map((m, i) => `[${i}] ${m.content}`).join('\n')
  const { object } = await generateObject({
    model,
    schema: rerankSchema,
    system: RERANK_SYSTEM,
    prompt: `QUESTION (data): ${query}\n\nITEMS (data):\n${items}`,
  })
  const scoreOf = new Map(object.scores.map((s) => [s.i, s.score]))
  // Stable reorder: judged score desc, original fusion order breaks ties.
  return memories
    .map((m, i) => ({ m, i, s: scoreOf.get(i) ?? 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m)
}
