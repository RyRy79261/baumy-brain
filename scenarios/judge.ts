import { generateObject } from 'ai'
import { z } from 'zod'
import { anthropicProvider } from '@/lib/ai/registry'
import { MODELS } from '@/lib/ai/models'

// Live-mode LLM judge (docs/spec/chat-understanding-v2.md §9). A worded reply from a real model
// can't be string-matched, so each expectWords({ judge }) rubric is checked by a model instead.
// Anthropic only, built from the same provider instance as production — but deliberately NOT via
// resolveModel, so the judge's own call never lands in the scenario's recorded model calls.

const JUDGE_SYSTEM = [
  'You grade replies written by Baumy, a house-secretary bot living in a shared-house Telegram group.',
  'You get the conversation so far, the reply under test, and a RUBRIC. Decide whether the reply satisfies EVERY point of the rubric.',
  'Judge only against the rubric — not tone, style or length unless the rubric says so. Be strict about factual claims the rubric forbids.',
  'Return pass (boolean) and a one-sentence reason naming the rubric point that failed, if any.',
].join(' ')

const verdictSchema = z.object({ pass: z.boolean(), reason: z.string() })

export async function judgeReply(input: { conversation: string; reply: string; rubric: string }): Promise<{ pass: boolean; reason: string }> {
  const { object } = await generateObject({
    model: anthropicProvider(MODELS.assess.id),
    schema: verdictSchema,
    system: JUDGE_SYSTEM,
    prompt: `CONVERSATION:\n${input.conversation}\n\nREPLY UNDER TEST:\n${input.reply}\n\nRUBRIC:\n${input.rubric}`,
  })
  return object
}
