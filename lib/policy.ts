import { eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'

// Response policy (data decision 16): the owner-configurable, dashboard-reversible
// control over when Baumy speaks. Stored as house_config.response_policy JSONB.
// Untrusted group text can NEVER write this (enforced upstream by the write-gate);
// only the owner (/pause, /resume) or the dashboard.
export interface ResponsePolicy {
  global_enabled: boolean
  categories: Record<string, boolean>
  confidence_threshold: number
  muted_topics: string[]
}

const DEFAULT: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [] }

export async function loadResponsePolicy(db: Database): Promise<ResponsePolicy> {
  const [row] = await db.select({ p: houseConfig.responsePolicy }).from(houseConfig).limit(1)
  const p = (row?.p ?? {}) as Partial<ResponsePolicy>
  return {
    global_enabled: p.global_enabled ?? DEFAULT.global_enabled,
    categories: p.categories ?? {},
    confidence_threshold: typeof p.confidence_threshold === 'number' ? p.confidence_threshold : DEFAULT.confidence_threshold,
    muted_topics: p.muted_topics ?? [],
  }
}

// Owner kill-switch. Upserts so it works whether or not the singleton is seeded.
export async function setGlobalEnabled(db: Database, enabled: boolean): Promise<void> {
  const current = await loadResponsePolicy(db)
  const next = { ...current, global_enabled: enabled }
  await db
    .insert(houseConfig)
    .values({ id: true, responsePolicy: next })
    .onConflictDoUpdate({ target: houseConfig.id, set: { responsePolicy: next, updatedAt: new Date() } })
}

// Replace the muted-topic list (owner-only, via the dashboard). Upserts the singleton.
export async function setMutedTopics(db: Database, topics: string[]): Promise<void> {
  const current = await loadResponsePolicy(db)
  const next = { ...current, muted_topics: topics }
  await db
    .insert(houseConfig)
    .values({ id: true, responsePolicy: next })
    .onConflictDoUpdate({ target: houseConfig.id, set: { responsePolicy: next, updatedAt: new Date() } })
}

export async function addMutedTopic(db: Database, topic: string): Promise<void> {
  const t = topic.trim().toLowerCase()
  if (!t) return
  const p = await loadResponsePolicy(db)
  if (!p.muted_topics.includes(t)) await setMutedTopics(db, [...p.muted_topics, t])
}

export async function removeMutedTopic(db: Database, topic: string): Promise<void> {
  const p = await loadResponsePolicy(db)
  await setMutedTopics(db, p.muted_topics.filter((t) => t !== topic))
}

// Deterministic reply filter layered on top of the write-gate: the paused
// kill-switch silences everything; below the confidence floor or a muted topic → quiet.
export function replyAllowed(policy: ResponsePolicy, confidence: number, text: string): boolean {
  if (!policy.global_enabled) return false
  if (!(confidence >= policy.confidence_threshold)) return false
  const t = text.toLowerCase()
  if (policy.muted_topics.some((m) => m && t.includes(m.toLowerCase()))) return false
  return true
}
