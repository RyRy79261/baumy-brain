import { createProviderRegistry } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { MODELS, type Role } from './models'

// Provider factories; keys come from env (ANTHROPIC_API_KEY / OPENAI_API_KEY).
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const registry = createProviderRegistry({ anthropic, openai })

// Resolve a language model for a routing role. Never inline ids at call sites.
export function resolveModel(role: Exclude<Role, 'embed'>) {
  const m = MODELS[role]
  return registry.languageModel(`${m.provider}:${m.id}`)
}

export function embeddingModel() {
  const m = MODELS.embed
  return registry.textEmbeddingModel(`${m.provider}:${m.id}`)
}

// Boot health-check (architecture F5): construct each configured model so a
// bad provider/id surfaces at startup, not on the first live call.
export function assertModelsResolvable(): void {
  ;(['classify', 'reply', 'assess', 'advisor'] as const).forEach((r) => resolveModel(r))
  embeddingModel()
}
