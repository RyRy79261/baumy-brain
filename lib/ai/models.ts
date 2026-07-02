// Model routing roles (decision C). IDs are pinned here + overridable via env;
// NEVER inline a model id at a call site. Exact ids/prices are verified at build
// (the defaults below are placeholders — override via BAUMY_*_MODEL env vars).
export type Role = 'classify' | 'reply' | 'assess' | 'advisor' | 'embed'

export const MODELS: Record<Role, { provider: 'openai' | 'anthropic'; id: string }> = {
  // Reactive path — cheap, capped, memory-only, tool-less, NEVER Opus.
  classify: { provider: 'openai', id: process.env.BAUMY_CLASSIFY_MODEL ?? 'gpt-4o-mini' },
  reply: { provider: 'anthropic', id: process.env.BAUMY_REPLY_MODEL ?? 'claude-haiku-4-5' },
  // Deliberative path — reached ONLY by explicit trusted intent + scheduled tasks.
  assess: { provider: 'anthropic', id: process.env.BAUMY_ASSESS_MODEL ?? 'claude-sonnet-4-5' },
  advisor: { provider: 'anthropic', id: process.env.BAUMY_ADVISOR_MODEL ?? 'claude-opus-4-1' },
  // Embeddings.
  embed: { provider: 'openai', id: process.env.BAUMY_EMBED_MODEL ?? 'text-embedding-3-small' },
}

// Anthropic reasoning models reject temperature/top_p/top_k (HTTP 400).
// Gate sampling params behind this; unknown → omit (safe default).
const SAMPLING_OK = /haiku|sonnet|opus-4-[0-6](?!\d)/i
export function modelAcceptsSampling(id: string): boolean {
  return SAMPLING_OK.test(id)
}
