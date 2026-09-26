import { createProviderRegistry } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { MODELS, type Role } from './models'

// Only Anthropic is used for language models; embeddings are local + in-process
// (lib/ai/embed.ts), so there is NO OpenAI/second-vendor dependency.
// Exported so provider-native server tools (e.g. Anthropic web search) can be built
// from the SAME configured instance — still Anthropic-only, no new vendor.
export const anthropicProvider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export const registry = createProviderRegistry({ anthropic: anthropicProvider })

type ResolvedModel = ReturnType<typeof registry.languageModel>

// TEST-ONLY seam (scenarios/fake-model.ts, docs/spec/chat-understanding-v2.md §9): when set, every
// role resolves through it instead of the Anthropic registry, so the scenario suite can script (or
// record) each LLM call while the REAL pipeline runs. Never set in production — unset, resolveModel
// behaves exactly as before. `real` is the model this role would otherwise resolve to, so a
// recorder can wrap it (live scenario mode) rather than replace it.
type ModelOverride = (role: Role, real: () => ResolvedModel) => ResolvedModel
let modelOverride: ModelOverride | null = null
export function setModelOverride(fn: ModelOverride | null): void {
  modelOverride = fn
}

function resolveRegistered(role: Role): ResolvedModel {
  const m = MODELS[role]
  return registry.languageModel(`${m.provider}:${m.id}`)
}

// Resolve a language model for a routing role. Never inline ids at call sites.
export function resolveModel(role: Role): ResolvedModel {
  return modelOverride ? modelOverride(role, () => resolveRegistered(role)) : resolveRegistered(role)
}

// Boot health-check (architecture F5): construct each configured model so a
// bad provider/id surfaces at startup, not on the first live call.
export function assertModelsResolvable(): void {
  ;(['classify', 'reply', 'assess', 'advisor'] as const).forEach((r) => resolveModel(r))
}
