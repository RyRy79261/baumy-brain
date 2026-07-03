import { and, eq, inArray, sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { facts, memoryItems, memoryEmbeddings } from '@/db/schema'
import { retrieve } from './retrieve'

// Deletion on request (owner feature). Two modes, both chosen by the requester's phrasing
// and shown in the proposal BEFORE anything commits:
//   soft  — hide from all recall/reflection/digests but keep the row (reversible, audited).
//   purge — redact the stored text/value + drop the embedding (right-to-be-forgotten).
// The golden rule holds: the LLM only picks a DESCRIPTION of what to forget; this code
// resolves it to concrete row ids, a human reviews the exact list, and only a confirm TAP
// (functions/callback.ts) runs forgetMemory. Group text never deletes anything on its own.
export type ForgetMode = 'soft' | 'purge'
export interface ForgetCandidate {
  kind: 'fact' | 'note'
  id: string
  content: string
}
export interface ForgetMatches {
  factIds: string[]
  noteIds: string[]
  candidates: ForgetCandidate[]
}
export interface ForgetDeps {
  db: Database
  embed: (t: string) => Promise<number[]>
}

const MATCH_LIMIT = 12 // proposal stays reviewable; the human confirms the exact list
const NOTE_FLOOR = 0.3

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

// What Baumy WOULD recall for this target — the exact set it proposes to forget. Facts
// match structurally (subject/alias/value substring or trigram); notes match via the same
// hybrid recall used for answers. Group-scoped + current/active only. The returned
// candidates and the {factIds,noteIds} to delete are the SAME rows, so the confirm card
// shows precisely what the tap will remove.
export async function findMemoryToForget(
  db: Database,
  groupId: string,
  target: string,
  deps: ForgetDeps,
): Promise<ForgetMatches> {
  const q = target.trim().toLowerCase()
  if (!q) return { factIds: [], noteIds: [], candidates: [] }

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
      ORDER BY f.recorded_at DESC
      LIMIT ${MATCH_LIMIT}`),
  )
  const factCands: ForgetCandidate[] = factRows.map((r) => ({
    kind: 'fact',
    id: String(r.id),
    content: `${r.subject as string} ${String(r.predicate).replace(/_/g, ' ')}${r.isSecure ? ' (secret)' : `: ${(r.objectValue as string | null) ?? ''}`}`,
  }))

  // Notes via the normal recall path (best-effort — a retrieval hiccup just means fewer
  // note candidates, never a crash). Secure notes show a placeholder, never the value.
  let noteCands: ForgetCandidate[] = []
  try {
    const mems = await retrieve(target, { groupId, k: MATCH_LIMIT, floor: NOTE_FLOOR }, deps)
    noteCands = mems.map((m) => ({
      kind: 'note',
      id: m.id,
      content: m.isSecure ? '🔒 a stored secret' : m.content.length > 120 ? `${m.content.slice(0, 117)}…` : m.content,
    }))
  } catch (err) {
    console.error('findMemoryToForget: note retrieval failed (proposing facts only):', err)
  }

  // Cap the combined list, then derive the delete-ids FROM the shown candidates so the
  // proposal and the commit target byte-for-byte the same rows.
  const candidates = [...factCands, ...noteCands].slice(0, MATCH_LIMIT)
  return {
    factIds: candidates.filter((c) => c.kind === 'fact').map((c) => c.id),
    noteIds: candidates.filter((c) => c.kind === 'note').map((c) => c.id),
    candidates,
  }
}

// Execute a confirmed forget. Group-scoped WHERE guards make it impossible to touch
// another house's rows even if an id were spoofed. soft = hide (bitemporal close +
// deleted_at marker / is_active=false); purge = redact plaintext + secret + drop the
// embedding so nothing can resurface it. Returns how many of each were affected.
export async function forgetMemory(
  db: Database,
  groupId: string,
  input: { factIds: string[]; noteIds: string[]; mode: ForgetMode },
): Promise<{ facts: number; notes: number }> {
  const now = new Date()
  let f = 0
  let n = 0

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

  if (input.noteIds.length) {
    const set = input.mode === 'purge' ? { isActive: false, content: '[redacted on request]', contentEncrypted: null } : { isActive: false }
    const res = await db
      .update(memoryItems)
      .set(set)
      .where(and(eq(memoryItems.groupId, groupId), inArray(memoryItems.id, input.noteIds)))
      .returning({ id: memoryItems.id })
    n = res.length
    if (input.mode === 'purge' && n > 0) {
      // Drop the vectors too — a purged note must not survive in the embedding space.
      await db.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryItemId, input.noteIds))
    }
  }

  return { facts: f, notes: n }
}
