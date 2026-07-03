import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { facts, memoryItems, memoryEmbeddings } from '@/db/schema'

// Deletion on request (owner feature). The UNIT of forgetting is the FACT (the distilled
// {subject,predicate,object} knowledge) — NOT the source message. A single message ("hi
// I'm Ryan, Charl is Charl Jacobs, Madeleine is Madeleine Goujon…") sources many facts
// about many people, so deleting that message to forget one name would nuke everyone
// else's info. Instead we remove the FACT and, on a purge, SURGICALLY scrub just the
// leaked value string out of the source messages — keeping the rest of each message.
//
// Two modes, shown in the proposal before anything commits:
//   soft  — hide the fact from recall (reversible, audited); source messages untouched.
//   purge — redact the fact's value AND scrub that value from the source messages (keep
//           the messages, re-embed), so the value is gone but its neighbours survive.
// Golden rule holds: the LLM only picks a target DESCRIPTION; this code resolves it to
// concrete rows + value strings, a human reviews, and only a confirm TAP runs the delete.
export type ForgetMode = 'soft' | 'purge'
export interface ForgetFact {
  id: string
  label: string
}
export interface ForgetMatches {
  factIds: string[]
  /** Concrete value strings (from the matched facts) to scrub out of source messages on a purge. */
  scrubValues: string[]
  /** Source messages that CONTAIN a scrub value — surgically redacted on a purge, never deleted. */
  noteIds: string[]
  /** For the proposal card: the facts to be forgotten, shown individually. */
  facts: ForgetFact[]
}

const MATCH_LIMIT = 15

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

// Case-insensitively replace every occurrence of each value with "[redacted]", keeping
// the surrounding text intact. Values are regex-escaped (they're data, not patterns).
export function redactValues(content: string, values: string[]): string {
  let out = content
  for (const v of values) {
    if (!v) continue
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, '[redacted]')
  }
  return out
}

const likeEscape = (v: string) => v.replace(/[\\%_]/g, '\\$&')

// Resolve a target description to the exact facts to forget + the value strings to scrub
// from source messages. Facts match structurally (subject/alias/value substring or
// trigram), group-scoped + current only, ranked so the most on-target fact leads. Source
// messages are found by CONTAINING a matched value (so we only ever touch a message that
// actually holds the thing being forgotten). The confirm card shows the exact facts.
export async function findMemoryToForget(db: Database, groupId: string, target: string): Promise<ForgetMatches> {
  const q = target.trim().toLowerCase()
  if (!q) return { factIds: [], scrubValues: [], noteIds: [], facts: [] }

  const factRows = rowsOf(
    await db.execute(sql`
      SELECT f.id,
             e.canonical_name AS subject,
             f.predicate AS predicate,
             f.object_value AS "objectValue",
             f.is_secure AS "isSecure"
      FROM baumy_facts f
      JOIN baumy_entities e ON f.subject_entity_id = e.id
      WHERE f.group_id = ${groupId} AND f.is_current = true AND length(e.canonical_name) > 0
        AND (
          position(e.canonical_name IN ${q}) > 0
          OR EXISTS (SELECT 1 FROM unnest(coalesce(e.aliases, '{}'::text[])) a WHERE length(a) > 0 AND position(a IN ${q}) > 0)
          OR (f.object_value IS NOT NULL AND position(lower(f.object_value) IN ${q}) > 0)
          OR word_similarity(e.canonical_name, ${q}) >= 0.6
          OR (f.object_value IS NOT NULL AND word_similarity(lower(f.object_value), ${q}) >= 0.6)
        )
      ORDER BY similarity(e.canonical_name || ' ' || replace(f.predicate, '_', ' ') || ' ' || coalesce(f.object_value, ''), ${q}) DESC,
               f.recorded_at DESC
      LIMIT ${MATCH_LIMIT}`),
  )

  const matched: ForgetFact[] = []
  const factIds: string[] = []
  const scrubSet = new Set<string>()
  for (const r of factRows) {
    factIds.push(String(r.id))
    matched.push({
      id: String(r.id),
      label: `${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}${r.isSecure ? ' (secret)' : `: ${(r.objectValue as string | null) ?? ''}`}`,
    })
    // Only a non-secret, meaningful value is worth scrubbing from source text (a secret's
    // plaintext is never stored in a note — capture keeps only a descriptor).
    if (!r.isSecure && typeof r.objectValue === 'string' && r.objectValue.trim().length >= 2) scrubSet.add(r.objectValue)
  }
  const scrubValues = [...scrubSet]

  // Source messages that literally contain a value being forgotten (for surgical purge).
  let noteIds: string[] = []
  if (scrubValues.length) {
    const rows = await db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.groupId, groupId),
          eq(memoryItems.isActive, true),
          or(...scrubValues.map((v) => ilike(memoryItems.content, `%${likeEscape(v)}%`))),
        ),
      )
    noteIds = rows.map((r) => r.id)
  }

  return { factIds, scrubValues, noteIds, facts: matched }
}

// Execute a confirmed forget. Group-scoped WHERE guards make it impossible to touch
// another house's rows even if an id were spoofed. Facts: soft = hide (bitemporal close +
// deleted_at); purge = also redact the plaintext value + secret ciphertext. Source
// messages are NEVER deleted — on a purge we surgically scrub the value strings out of
// their content (keeping everything else) and drop their embeddings so the re-embed sweep
// re-vectorises the redacted text; on a soft delete they are left completely untouched.
export async function forgetMemory(
  db: Database,
  groupId: string,
  input: { factIds: string[]; scrubValues: string[]; noteIds: string[]; mode: ForgetMode },
): Promise<{ facts: number; messagesScrubbed: number }> {
  const now = new Date()
  let f = 0
  let messagesScrubbed = 0

  if (input.factIds.length) {
    const base = { isCurrent: false, deletedAt: now, invalidatedAt: now, validTo: now }
    const set = input.mode === 'purge' ? { ...base, objectValue: '[redacted on request]', objectJson: null, valueCiphertext: null, valueIv: null } : base
    const res = await db
      .update(facts)
      .set(set)
      .where(and(eq(facts.groupId, groupId), inArray(facts.id, input.factIds)))
      .returning({ id: facts.id })
    f = res.length
  }

  // Surgical source-message scrub — PURGE ONLY, and only the matched value strings.
  if (input.mode === 'purge' && input.noteIds.length && input.scrubValues.length) {
    const notes = await db
      .select({ id: memoryItems.id, content: memoryItems.content })
      .from(memoryItems)
      .where(and(eq(memoryItems.groupId, groupId), inArray(memoryItems.id, input.noteIds)))
    const scrubbedIds: string[] = []
    for (const nt of notes) {
      const redacted = redactValues(nt.content, input.scrubValues)
      if (redacted !== nt.content) {
        await db.update(memoryItems).set({ content: redacted }).where(eq(memoryItems.id, nt.id))
        scrubbedIds.push(nt.id)
      }
    }
    if (scrubbedIds.length) {
      // Drop the stale vectors (they still encode the removed value) — the re-embed sweep
      // regenerates them from the now-redacted content. Lexical (content_tsv) updates itself.
      await db.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryItemId, scrubbedIds))
    }
    messagesScrubbed = scrubbedIds.length
  }

  return { facts: f, messagesScrubbed }
}
