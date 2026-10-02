import { type Database } from '@/db/client'
import { sql, type SQL } from 'drizzle-orm'
import { houseConfig } from '@/db/schema'
import { now as clockNow } from '@/lib/core/clock'

// Response policy (data decision 16): the owner-configurable, dashboard-reversible
// control over when Baumy speaks. Stored as house_config.response_policy JSONB.
// Untrusted group text can NEVER write this (enforced upstream by the write-gate);
// only the owner (/pause, /resume) or the dashboard.
// How readily Baumy VOLUNTEERS a worded reply in the group. Baumy's whole point is to
// remember without polluting the chat, so this tunes the bar an *unaddressed* question's
// triage `replyValue` (how useful an answer would be) must clear to earn words — a direct
// @mention/reply always answers regardless.
// A reaction (✍/👀/…) is never gated by this: it's cheap and doesn't pollute.
export type ReplyFrequency = 'quiet' | 'balanced' | 'chatty'
// The floor per level. 'balanced' == the historical 0.7 default, so existing
// houses are unchanged. 'quiet' only speaks when an answer is clearly worth giving;
// 'chatty' jumps in more readily.
export const REPLY_FLOORS: Record<ReplyFrequency, number> = { quiet: 0.85, balanced: 0.7, chatty: 0.5 }

// How often the proactive reminder/event DIGEST fires per day (docs/spec/reminders.md). 'twice'
// splits the waking day into ~12h segments (a morning + an evening batch); 'once' is a single
// morning batch. It's a batched heads-up, NOT an alarm — an explicit "remind me at X" still fires
// near its time on its own. Only the WAKING-hour slots (never 02:00–06:00) ever send.
export type ReminderFrequency = 'once' | 'twice'

export interface ResponsePolicy {
  global_enabled: boolean
  categories: Record<string, boolean>
  confidence_threshold: number
  muted_topics: string[]
  reply_frequency: ReplyFrequency
  reminder_frequency: ReminderFrequency
}

const DEFAULT: ResponsePolicy = {
  global_enabled: true,
  categories: {},
  confidence_threshold: 0.7,
  muted_topics: [],
  // Baumy is a secretary, not a chatterbox: default to 'quiet' (0.85 floor) so an UNaddressed
  // message only earns words when it's clearly meaningful — a direct @mention/reply/DM still
  // always answers, and reactions are never gated. The owner can retune live in the dashboard.
  reply_frequency: 'quiet',
  reminder_frequency: 'twice',
}

// The effective floor a volunteered reply's replyValue must clear — driven by reply_frequency.
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
    reminder_frequency: p.reminder_frequency === 'once' || p.reminder_frequency === 'twice' ? p.reminder_frequency : DEFAULT.reminder_frequency,
  }
}

// Who changed the policy: the audit row is written by the SAME statement as the change.
export interface PolicyAudit {
  actor: string
  action: string
  metadata?: Record<string, unknown> | null
}

// The stored document as it is in the conflicting singleton row (only valid inside DO UPDATE).
const STORED = sql`coalesce(baumy_house_config.response_policy, '{}'::jsonb)`

// One atomic statement per change. The singleton is patched field by field — never a read-modify-
// write of the whole document, so two housemates changing different settings at once can't undo
// each other. When audited, the audit row is inserted from that same statement, so a policy change
// never lands without its row (neon-http has no transactions; one statement is atomic).
async function patchPolicy(db: Database, merged: SQL, seed: Record<string, unknown>, audit?: PolicyAudit): Promise<void> {
  const upsert = sql`INSERT INTO baumy_house_config (id, response_policy)
    VALUES (true, ${JSON.stringify({ ...DEFAULT, ...seed })}::jsonb)
    ON CONFLICT (id) DO UPDATE SET response_policy = ${merged}, updated_at = ${clockNow().toISOString()}::timestamptz`
  if (!audit) {
    await db.execute(upsert)
    return
  }
  const metadata = audit.metadata == null ? sql`NULL` : sql`${JSON.stringify(audit.metadata)}::jsonb`
  await db.execute(sql`WITH changed AS (${upsert} RETURNING id)
    INSERT INTO baumy_audit_log (action, actor_member_id, target, metadata)
    SELECT ${audit.action}, ${audit.actor}, NULL, ${metadata} FROM changed`)
}

// Merge top-level keys into the stored document.
function setFields(db: Database, fields: Partial<ResponsePolicy>, audit?: PolicyAudit): Promise<void> {
  return patchPolicy(db, sql`${STORED} || ${JSON.stringify(fields)}::jsonb`, fields, audit)
}

// Set how readily Baumy volunteers replies (any dashboard member). Upserts the singleton.
export async function setReplyFrequency(db: Database, level: ReplyFrequency, audit?: PolicyAudit): Promise<void> {
  if (!(level in REPLY_FLOORS)) return // fail closed on a bad value
  await setFields(db, { reply_frequency: level }, audit)
}

// Set how often the reminder/event digest fires (via the dashboard). Upserts the singleton.
export async function setReminderFrequency(db: Database, level: ReminderFrequency, audit?: PolicyAudit): Promise<void> {
  if (level !== 'once' && level !== 'twice') return // fail closed on a bad value
  await setFields(db, { reminder_frequency: level }, audit)
}

// The pause switch. Upserts so it works whether or not the singleton is seeded.
export async function setGlobalEnabled(db: Database, enabled: boolean, audit?: PolicyAudit): Promise<void> {
  await setFields(db, { global_enabled: enabled }, audit)
}

// Replace the muted-topic list. Upserts the singleton.
export async function setMutedTopics(db: Database, topics: string[], audit?: PolicyAudit): Promise<void> {
  await setFields(db, { muted_topics: topics }, audit)
}

const STORED_TOPICS = sql`coalesce(${STORED} -> 'muted_topics', '[]'::jsonb)`

// Add one topic in place (lowercased, de-duped by the database, not by a stale read).
export async function addMutedTopic(db: Database, topic: string, audit?: PolicyAudit): Promise<void> {
  const t = topic.trim().toLowerCase()
  if (!t) return
  const one = JSON.stringify([t])
  await patchPolicy(
    db,
    sql`jsonb_set(${STORED}, '{muted_topics}', CASE WHEN ${STORED_TOPICS} @> ${one}::jsonb THEN ${STORED_TOPICS} ELSE ${STORED_TOPICS} || ${one}::jsonb END)`,
    { muted_topics: [t] },
    audit,
  )
}

// Remove one topic in place.
export async function removeMutedTopic(db: Database, topic: string, audit?: PolicyAudit): Promise<void> {
  await patchPolicy(
    db,
    sql`jsonb_set(${STORED}, '{muted_topics}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(${STORED_TOPICS}) AS e WHERE e <> ${JSON.stringify(topic)}::jsonb), '[]'::jsonb))`,
    { muted_topics: [] },
    audit,
  )
}

// Deterministic reply filter layered on top of the write-gate: the paused
// kill-switch silences everything; below the reply-frequency floor or a muted topic → quiet.
// (A direct @mention/reply bypasses this in the caller — this only gates VOLUNTEERED replies.)
// `replyValue` is triage's "how useful would a volunteered answer be" (lib/ai/classify.ts) — NOT its
// confidence in the intent, which measured certainty of the label and let a sure-but-rhetorical
// question through while silencing a useful ambiguous one (I6, second half).
export function replyAllowed(policy: ResponsePolicy, replyValue: number, text: string): boolean {
  if (!policy.global_enabled) return false
  if (!(replyValue >= replyConfidenceFloor(policy))) return false
  if (policy.muted_topics.some((m) => mentionsTopic(text, m))) return false
  return true
}

// Does `text` mention the muted topic as a WHOLE word/phrase (I10)? A raw substring match made
// "bin" also mute "cabinet" and "robin". Unicode-aware boundaries (letters/digits on either side
// break the match), case-insensitive; a multi-word topic matches with any run of whitespace, and a
// plain plural still counts ("bin" mutes "bins", not "binary").
export function mentionsTopic(text: string, topic: string): boolean {
  const m = topic.trim().toLowerCase()
  if (!m) return false
  const esc = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?:e?s)?(?![\\p{L}\\p{N}])`, 'iu').test(text)
}
