// Model routing roles (decision C). IDs are pinned here + overridable via env;
// NEVER inline a model id at a call site. Exact ids/prices are verified at build
// (the defaults below are placeholders — override via BAUMY_*_MODEL env vars).
export type Role = 'classify' | 'reply' | 'assess' | 'advisor'

// All language models are Anthropic (embeddings are local — lib/ai/embed.ts).
export const MODELS: Record<Role, { provider: 'anthropic'; id: string }> = {
  // Reactive path — cheap, capped, memory-only, tool-less, NEVER Opus. The
  // classifier moved OpenAI-nano → Haiku so there is no second vendor.
  classify: { provider: 'anthropic', id: process.env.BAUMY_CLASSIFY_MODEL ?? 'claude-haiku-4-5-20251001' },
  reply: { provider: 'anthropic', id: process.env.BAUMY_REPLY_MODEL ?? 'claude-haiku-4-5-20251001' },
  // Deliberative path — reached ONLY by explicit trusted intent + scheduled tasks.
  assess: { provider: 'anthropic', id: process.env.BAUMY_ASSESS_MODEL ?? 'claude-sonnet-5' },
  advisor: { provider: 'anthropic', id: process.env.BAUMY_ADVISOR_MODEL ?? 'claude-opus-4-8' },
}

// Anthropic reasoning models reject temperature/top_p/top_k (HTTP 400).
// Gate sampling params behind this; unknown → omit (safe default).
const SAMPLING_OK = /haiku|sonnet|opus-4-[0-6](?!\d)/i
export function modelAcceptsSampling(id: string): boolean {
  return SAMPLING_OK.test(id)
}
