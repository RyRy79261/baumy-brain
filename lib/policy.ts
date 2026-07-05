import { type Database } from '@/db/client'
import { houseConfig } from '@/db/schema'

// Response policy (data decision 16): the owner-configurable, dashboard-reversible
// control over when Baumy speaks. Stored as house_config.response_policy JSONB.
// Untrusted group text can NEVER write this (enforced upstream by the write-gate);
// only the owner (/pause, /resume) or the dashboard.
// How readily Baumy VOLUNTEERS a worded reply in the group. Baumy's whole point is to
// remember without polluting the chat, so this tunes the confidence bar an *unaddressed*
// message must clear to earn words — a direct @mention/reply always answers regardless.
// A reaction (🧠/👀/…) is never gated by this: it's cheap and doesn't pollute.
export type ReplyFrequency = 'quiet' | 'balanced' | 'chatty'
// The confidence floor per level. 'balanced' == the historical 0.7 default, so existing
// houses are unchanged. 'quiet' only speaks when it's clearly meaningful new information;
// 'chatty' jumps in more readily.
export const REPLY_FLOORS: Record<ReplyFrequency, number> = { quiet: 0.85, balanced: 0.7, chatty: 0.5 }

export interface ResponsePolicy {
  global_enabled: boolean
  categories: Record<string, boolean>
  confidence_threshold: number
  muted_topics: string[]
  reply_frequency: ReplyFrequency
}

const DEFAULT: ResponsePolicy = { global_enabled: true, categories: {}, confidence_threshold: 0.7, muted_topics: [], reply_frequency: 'balanced' }

// The effective confidence floor a volunteered reply must clear — driven by reply_frequency.
export function replyConfidenceFloor(policy: ResponsePolicy): number {
  return REPLY_FLOORS[policy.reply_frequency] ?? policy.confidence_threshold
}

export async function loadResponsePolicy(db: Database): Promise<ResponsePolicy> {
  const [row] = await db.select({ p: houseConfig.responsePolicy }).from(houseConfig).limit(1)
  const p = (row?.p ?? {}) as Partial<ResponsePolicy>
  return {
    global_enabled: p.global_enabled ?? DEFAULT.global_enabled,
    categories: p.categories ?? {},
    confidence_threshold: typeof p.confidence_threshold === 'number' ? p.confidence_threshold : DEFAULT.confidence_threshold,
    muted_topics: p.muted_topics ?? [],
    reply_frequency: p.reply_frequency && p.reply_frequency in REPLY_FLOORS ? p.reply_frequency : DEFAULT.reply_frequency,
  }
}

// Set how readily Baumy volunteers replies (owner-only, via the dashboard). Upserts the singleton.
export async function setReplyFrequency(db: Database, level: ReplyFrequency): Promise<void> {
  if (!(level in REPLY_FLOORS)) return // fail closed on a bad value
  const current = await loadResponsePolicy(db)
  const next = { ...current, reply_frequency: level }
  await db
    .insert(houseConfig)
    .values({ id: true, responsePolicy: next })
    .onConflictDoUpdate({ target: houseConfig.id, set: { responsePolicy: next, updatedAt: new Date() } })
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
// kill-switch silences everything; below the reply-frequency floor or a muted topic → quiet.
// (A direct @mention/reply bypasses this in the caller — this only gates VOLUNTEERED replies.)
export function replyAllowed(policy: ResponsePolicy, confidence: number, text: string): boolean {
  if (!policy.global_enabled) return false
  if (!(confidence >= replyConfidenceFloor(policy))) return false
  const t = text.toLowerCase()
  if (policy.muted_topics.some((m) => m && t.includes(m.toLowerCase()))) return false
  return true
}
