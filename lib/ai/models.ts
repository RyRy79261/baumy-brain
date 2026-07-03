// Model routing roles (decision C). IDs are pinned here + overridable via env;
// NEVER inline a model id at a call site. Exact ids/prices are verified at build
// (the defaults below are placeholders — override via BAUMY_*_MODEL env vars).
export type Role = 'classify' | 'reply' | 'assess' | 'advisor'

// All language models are Anthropic (embeddings are local — lib/ai/embed.ts).
export const MODELS: Record<Role, { provider: 'anthropic'; id: string }> = {
  // ROUTING ONLY — the cheap high-volume triage that decides respond/react/ignore +
  // tier. This is the ONLY Haiku use; everything that reasons runs on Sonnet.
  classify: { provider: 'anthropic', id: process.env.BAUMY_CLASSIFY_MODEL ?? 'claude-haiku-4-5-20251001' },
  // PRIMARY reasoning — grounded replies + memory ops (fact extraction, query
  // expansion, re-rank, reminder parsing). Sonnet by default; the reply self-escalates.
  reply: { provider: 'anthropic', id: process.env.BAUMY_REPLY_MODEL ?? 'claude-sonnet-5' },
  assess: { provider: 'anthropic', id: process.env.BAUMY_ASSESS_MODEL ?? 'claude-sonnet-5' },
  // ADVISOR — the escalation ceiling: a model may signal it needs more, and the reply
  // bumps Sonnet → Opus for that turn only. Also the scheduled-task deliberative tier.
  advisor: { provider: 'anthropic', id: process.env.BAUMY_ADVISOR_MODEL ?? 'claude-opus-4-8' },
}
