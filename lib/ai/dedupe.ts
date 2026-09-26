import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { resolveModel } from './registry'
import { ENTITY_DEDUPE_SYSTEM } from './prompts'
import { isMalformedObjectError } from './errors'

// The nightly hygiene sweep's one LLM step (spec §7, F12): of the candidate entity pairs CODE picked
// (lib/memory/hygiene.ts), which name the same thing? A proposal only — the sweep keeps only indexes it
// offered and re-checks every guard before merging. Best-effort on a malformed object (→ no merges);
// a transient provider error rethrows so the cron retries.
export const dedupeSchema = z.object({ same: z.array(z.number().int().min(0)) })

export interface MergePair {
  a: string
  b: string
  kind: string
}

export async function proposeEntityMerges(pairs: MergePair[], model: LanguageModel = resolveModel('assess')): Promise<number[]> {
  if (!pairs.length) return []
  try {
    const { object } = await generateObject({
      model,
      schema: dedupeSchema,
      system: ENTITY_DEDUPE_SYSTEM,
      prompt: `PAIRS (data):\n${pairs.map((p, i) => `[${i}] ${JSON.stringify(p.a)} vs ${JSON.stringify(p.b)} (${p.kind})`).join('\n')}`,
    })
    return [...new Set(object.same)].filter((i) => i < pairs.length)
  } catch (err) {
    if (!isMalformedObjectError(err)) throw err
    console.warn('[baumy/dedupe] malformed proposal — no merges this run:', err instanceof Error ? err.message : err)
    return []
  }
}
