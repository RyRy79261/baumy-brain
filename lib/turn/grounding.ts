import { type Database } from '@/db/client'
import { retrieve, retrieveExpanded, type RetrievedMemory } from '@/lib/memory/retrieve'
import { currentFactsForQuery } from '@/lib/memory/facts'
import { gatherGraphContext, type GraphContextItem } from '@/lib/memory/graph'
import { memberDisplayNames } from '@/lib/identity/roster'
import { askedAuthor, type LookupSpeaker } from '@/lib/memory/lookup'
import { expandQuery } from '@/lib/ai/expand'
import { rerank } from '@/lib/ai/rerank'
import { decryptSecret } from '@/lib/core/crypto'
import { asksForSecret } from '@/lib/core/sensitivity'
import type { GroundingItem } from '@/lib/ai/reply'
import type { ReplyMode } from './plan'
import type { TurnContext } from './context'

// The reply's MEMORY block (docs/spec/chat-understanding-v2.md §4): hybrid recall + current facts
// (+ the fact-graph walk on the deep tier), each line attributed and DATED, and — the C1 fix —
// WITHOUT this turn's own evidence note or the facts it just wrote. Otherwise the message ranks
// first on self-similarity and comes back as "(from Charli) Zuzka is staying in my room", which is
// how Charli got her own statement quoted back at her, and why the honest "nobody has mentioned
// that" could never fire for a captured message.
//
// Every retrieval arm stays group-scoped / active-only / quarantine-excluded / current-embedding-
// model-only (lib/memory/retrieve.ts); nothing here widens that.

// Old notes of these kinds are chatter or a question someone ASKED — never evidence of a fact
// (I3). New ones are no longer captured; this keeps pre-v2 rows from grounding answers.
const NOT_EVIDENCE = new Set(['question', 'chatter', 'banter'])

export interface Grounding {
  items: GroundingItem[]
  /** Non-secret memory for the one tool-enabled generation (web search) — never decrypted. */
  forWeb: { content: string; authoredBy: string | null }[]
  /** Descriptors of the secure values decrypted into `items` for this answer ([] almost always). The
   *  reply may then contain a secret the pattern scan cannot see, so the conversation window stores
   *  a placeholder instead of the words (spec §5: a secret is never persisted). */
  disclosed: string[]
}

export async function gatherGrounding(db: Database, ctx: TurnContext, opts: { deep: boolean; mode: ReplyMode }): Promise<Grounding> {
  const scope = ctx.houseScope
  const query = ctx.text
  const excludeNotes = ctx.outcome.captured ? [ctx.outcome.captured.memoryItemId] : []
  const excludeFacts = ctx.outcome.captured?.factIds ?? []
  const { deep } = opts
  // Who is asking (the authenticated sender — "I / my / me" are them, F4) and, for "what did X say",
  // whose words to look for (F13). Both from the turn + roster, never from the text's claims.
  const names = await memberDisplayNames(db)
  const speaker: LookupSpeaker | null = ctx.authorId ? { memberId: ctx.authorId, firstName: ctx.sender.firstName } : null
  const authorId = askedAuthor(query, names, speaker)

  // Deep tier earns query expansion (wider recall) + a re-rank (precision); both best-effort,
  // degrading to plain hybrid retrieval on any hiccup.
  let memories: RetrievedMemory[]
  if (deep) {
    let expansions: string[] = []
    try {
      expansions = await expandQuery(query)
    } catch (err) {
      console.warn('[baumy/grounding] query expansion failed — using the raw query:', err instanceof Error ? err.message : err)
    }
    const ropts = { groupId: scope, k: 30, floor: 0.05, excludeIds: excludeNotes, authorId }
    memories = expansions.length ? await retrieveExpanded(query, expansions, ropts, { db }) : await retrieve(query, ropts, { db })
    try {
      memories = await rerank(query, memories)
    } catch (err) {
      console.warn('[baumy/grounding] re-rank failed — keeping the fusion order:', err instanceof Error ? err.message : err)
    }
  } else {
    memories = await retrieve(query, { groupId: scope, k: 8, floor: 0.2, excludeIds: excludeNotes, authorId }, { db })
  }
  memories = memories.filter((m) => !excludeNotes.includes(m.id) && !NOT_EVIDENCE.has(m.memoryType))

  const factHits = await currentFactsForQuery(db, scope, query, deep ? 15 : 5, excludeFacts, { speaker, authorId })
  // Deep tier: WALK the fact graph from the query's entities — cross-subject connections + the top
  // subject's timeline. Enrichment only: any error degrades to [].
  let graphItems: GraphContextItem[] = []
  if (deep) {
    try {
      graphItems = (await gatherGraphContext(db, scope, query, { speaker })).filter((g) => !g.factId || !excludeFacts.includes(g.factId))
    } catch (err) {
      // Graph traversal is enrichment only — never fail the reply on it (but never hide it either).
      console.warn('[baumy/grounding] graph walk failed — no graph context:', err instanceof Error ? err.message : err)
    }
  }

  // Authors by NAME (not raw id) so the model can attribute + resolve first person in a note.
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  const items: GroundingItem[] = [
    ...factHits.map((f) => {
      // Fold the lineage parent in — only ever the value this fact REPLACED, or the previous occurrence
      // of the same thing (F8) — so the model can narrate the change and who made it ("you said Friday,
      // Marco says Saturday now").
      const prior = nameOf(f.priorAuthoredBy)
      const content = f.priorContent ? `${f.content} (earlier: ${f.priorContent}${prior ? `, per ${prior}` : ''})` : f.content
      return {
        // A reflect profile is background synthesis (F11): its own kind, ranked last by the lookup.
        kind: f.isProfile ? ('profile' as const) : ('fact' as const),
        who: nameOf(f.authoredBy),
        saidAt: f.recordedAt,
        eventAt: f.eventAt,
        validTo: f.validTo,
        content,
        isSecure: f.isSecure,
        contentEncrypted: f.contentEncrypted,
      }
    }),
    ...memories.map((m) => ({
      kind: 'note' as const,
      who: nameOf(m.authoredBy),
      // A member-forwarded note (D4) is labelled with its forwarder, never attributed to them.
      ...(m.trustLevel === 'forwarded' ? { forwarded: { by: nameOf(m.forwardedBy ?? null) } } : {}),
      saidAt: m.createdAt ? new Date(m.createdAt) : null,
      content: m.content,
      isSecure: m.isSecure,
      contentEncrypted: m.contentEncrypted,
    })),
    ...graphItems.map((g) => ({
      kind: g.memoryType,
      who: nameOf(g.authoredBy),
      saidAt: g.saidAt ?? null,
      content: g.content,
      isSecure: false,
      contentEncrypted: null,
    })),
  ]

  const forWeb = items.filter((m) => !m.isSecure).map((m) => ({ content: m.content, authoredBy: m.who }))
  const shown = disclose(items, opts.mode, query)
  const disclosed = items.flatMap((m, i) => (shown[i].content !== m.content ? [m.content] : []))
  return { items: shown, forWeb, disclosed }
}

// Disclosure discretion (memory-core #15, C15): a secure value is decrypted ONLY to answer a direct
// question for THAT value — never for an ack/confirm/banter line, and never because the message
// merely mentions the same thing. Everything else keeps its non-secret descriptor.
export function disclose(items: GroundingItem[], mode: ReplyMode, question: string): GroundingItem[] {
  return items.map((m) => {
    if (!(m.isSecure && m.contentEncrypted) || mode !== 'answer' || !asksForSecret(question, m.content)) return m
    try {
      return { ...m, content: `${m.content}: ${decryptSecret(m.contentEncrypted)}` }
    } catch {
      return m // one undecryptable blob must not fail the whole reply — keep its descriptor
    }
  })
}
