import { sql, type SQL } from 'drizzle-orm'
import { now as clockNow } from '@/lib/core/clock'
import { EMBED_MODEL } from '@/lib/ai/embed'

// What "current" means for a fact (docs/spec/chat-understanding-v2.md §6, T2):
//
//     is_current AND (valid_to IS NULL OR valid_to > now)
//
// is_current alone says the fact was never superseded or forgotten; valid_to says when what it
// describes is OVER — a stay, a visit, a party (set at capture from the event's end). Before this, a
// March visit stayed "current" forever: it grounded replies, /guests and reflect profiles in
// September. An expired fact is still true as HISTORY — the entity timeline shows it "(past)" — it is
// just no longer what is going on now.
//
// `now` is always passed in as a parameter (default: the clock seam), never Postgres now(): a sandbox
// run at a simulated instant must expire facts on ITS day (T13). `alias` is a trusted SQL identifier
// from our own code (never input).
export function liveFact(alias: string, at: Date = clockNow()): SQL {
  const a = sql.raw(alias)
  return sql`(${a}.is_current AND (${a}.valid_to IS NULL OR ${a}.valid_to > ${at.toISOString()}))`
}

/** The complement for an is_current row: its event is over (valid_to has passed). */
export function expiredFact(alias: string, at: Date = clockNow()): SQL {
  const a = sql.raw(alias)
  return sql`(${a}.valid_to IS NOT NULL AND ${a}.valid_to <= ${at.toISOString()})`
}

// What may be RECALLED from the house's notes (baumy_memory_items): group-scoped, active (not hidden by
// a forget or an edit), and never bot-origin content (quarantined). A member-FORWARDED note passes by
// design — it comes back with trustLevel/forwardedBy so the reply labels it "forwarded by X". Every
// retrieval arm uses this; a semantic arm adds currentEmbedding on its embeddings join. `alias` is a
// trusted SQL identifier from our own code (never input).
export function recallableNote(alias: string, groupId: string): SQL {
  const a = sql.raw(alias)
  return sql`(${a}.group_id = ${groupId} AND ${a}.is_active AND ${a}.trust_level <> 'quarantined')`
}

/** A note in a housemate's OWN words: recallable, not forwarded, not a secret — what may consolidate a
 *  repeat (write.ts) and what reflect synthesises a profile from. */
export function firsthandNote(alias: string, groupId: string): SQL {
  const a = sql.raw(alias)
  return sql`(${recallableNote(alias, groupId)} AND ${a}.trust_level <> 'forwarded' AND NOT ${a}.is_secure)`
}

/** Only vectors from the current embedder: the production space and the embedSync fallback are never
 *  cosine-compared. `alias` names a baumy_memory_embeddings row. */
export function currentEmbedding(alias: string): SQL {
  return sql`(${sql.raw(alias)}.model = ${EMBED_MODEL})`
}
