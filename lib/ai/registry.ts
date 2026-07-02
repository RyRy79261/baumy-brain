import { createProviderRegistry } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { MODELS, type Role } from './models'

// Only Anthropic is used for language models; embeddings are local + in-process
// (lib/ai/embed.ts), so there is NO OpenAI/second-vendor dependency.
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export const registry = createProviderRegistry({ anthropic })

// Resolve a language model for a routing role. Never inline ids at call sites.
export function resolveModel(role: Role) {
  const m = MODELS[role]
  return registry.languageModel(`${m.provider}:${m.id}`)
}

// Boot health-check (architecture F5): construct each configured model so a
// bad provider/id surfaces at startup, not on the first live call.
export function assertModelsResolvable(): void {
  ;(['classify', 'reply', 'assess', 'advisor'] as const).forEach((r) => resolveModel(r))
}
