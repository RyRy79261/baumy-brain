import { predicatesCuedBy } from '@/lib/memory/predicates'

// How a question is matched against the fact graph's names (docs/spec/chat-understanding-v2.md §7 —
// F4, F7, F13). Pure and I/O-free: the SQL callers (lib/memory/facts.ts currentFactsForQuery,
// lib/memory/graph.ts resolveSeedEntities) fetch candidates, this decides what matched and how well.
//
// What went wrong before: names were matched with position(name IN query) — no word boundary, so the
// entity "al" matched "at all" — every match ranked the same and the newest won, so the 'house' hub
// (every "we/our" fact) crowded the one named subject out of a 5-row limit; only the SUBJECT was
// matched ("who's in the cave?" found nothing); and "my room" was never the asker's room.

/** The hub entities every "we / us / our" fact lands on — a match on one ranks below a named subject. */
export const HUB_NAMES = new Set(['house', 'home', 'flat', 'household', 'apartment', 'everyone', 'we', 'us'])

/** Minimum name length for the trigram (typo) arm — short names ("al", "ed") only ever match whole. */
export const FUZZY_MIN_LEN = 4

// Separators: whitespace and ASCII punctuation except the apostrophe (so "charli's" stays one token).
// Everything else — letters of any script, digits — is part of a word.
const SEPARATORS = /[^\p{L}\p{N}']+/gu

/** Lowercase, curly quotes straightened, split on separators, re-joined with single spaces and
 *  padded — so a whole-word test is a plain `includes(' name ')`. */
export function wordText(raw: string): string {
  const s = raw.toLowerCase().replace(/[’‘`]/g, "'").replace(SEPARATORS, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, '$1').trim()
  return ` ${s.replace(/\s+/g, ' ')} `
}

/** A name as a word sequence (article stripped — entity names are stored without one). */
export function nameWords(name: string): string {
  return wordText(name).replace(/^ (the|a|an) /, ' ')
}

/** Is `name` present in `text` as whole words (or its plain plural — "sinks" names the sink)? `text`
 *  must come from wordText/lookupText. */
export function hasName(text: string, name: string): boolean {
  const n = nameWords(name)
  return n.trim().length > 0 && (text.includes(n) || text.includes(`${n.trimEnd()}s `))
}

export interface LookupSpeaker {
  /** The authenticated sender's member id. */
  memberId: string
  /** Their first name — what "I / me / my" become. */
  firstName: string
}

const FIRST_PERSON: Record<string, (first: string) => string> = {
  i: (f) => f,
  me: (f) => f,
  myself: (f) => f,
  "i'm": (f) => f,
  "i've": (f) => f,
  "i'll": (f) => f,
  "i'd": (f) => f,
  my: (f) => `${f}'s`,
  mine: (f) => `${f}'s`,
}

/**
 * The text a question is matched with: word-normalised, first person resolved to the SENDER ("who's
 * in my room?" from Charli → "who's in charli's room") — the sender comes from the authenticated turn,
 * never from the text — plus a copy with possessives dropped, so "charli's sister" also names charli
 * (the graph seed) while the exact "charli's bike" still ranks as the more specific match. The two
 * halves are joined by " | " so no name can match across the seam.
 */
export function lookupText(query: string, speaker?: LookupSpeaker | null): string {
  let words = wordText(query).trim().split(' ').filter(Boolean)
  const first = speaker?.firstName ? wordText(speaker.firstName).trim().split(' ')[0] : ''
  if (first) words = words.map((w) => (FIRST_PERSON[w] ? FIRST_PERSON[w](first) : w))
  const exact = words.join(' ')
  const bare = words.map((w) => w.replace(/'s$/, '')).join(' ')
  return bare === exact ? ` ${exact} ` : ` ${exact} | ${bare} `
}

/** The set of single words in a lookup text (for predicate cues). */
export function lookupWords(text: string): Set<string> {
  return new Set(text.split(' ').filter((w) => w && w !== '|'))
}

export interface EntityRow {
  id: string
  name: string
  aliases: string[]
  kind: string
  /** pg_trgm word_similarity(name, query) — the typo arm. */
  similarity?: number
}

export type EntityMatchKind = 'named' | 'hub' | 'fuzzy' | 'part'

export interface EntityMatch {
  id: string
  kind: EntityMatchKind
  /** Longer / multi-word names are more specific ("charli's room" beats "charli"). */
  specificity: number
}

const specificityOf = (name: string) => {
  const n = nameWords(name).trim()
  return n.split(' ').length * 10 + Math.min(n.length, 30) / 3
}

const STOP_HEADS = new Set(['thing', 'stuff', 'one', 'place', 'time', 'day', 'week', 'people', 'person'])

/**
 * Which entities the lookup text refers to, and how:
 *   named — the name (or an alias) is in the text as whole words;
 *   hub   — the same, for a hub ('house' — every "we/our" fact), which ranks below any named subject;
 *   fuzzy — weaker evidence: a typo-level trigram match (names of FUZZY_MIN_LEN+ only) or the HEAD noun
 *           of a qualified name ("is the sink fixed?" → "kitchen sink"; the read side fuzzes generously,
 *           the write side never merges them — facts.ts);
 *   part  — a name only present INSIDE a longer matched name ("room" inside "marco's room", "charli"
 *           inside "charli's room") — the longer, more specific match is what was asked about.
 */
export function matchEntities(rows: EntityRow[], text: string, fuzzyThreshold = 0.6): EntityMatch[] {
  const out: (EntityMatch & { names: string[] })[] = []
  for (const e of rows) {
    const names = [e.name, ...e.aliases].filter((n) => n && n.trim())
    const hit = names.filter((n) => hasName(text, n))
    if (hit.length) {
      const hub = names.some((n) => HUB_NAMES.has(nameWords(n).trim()))
      out.push({ id: e.id, kind: hub ? 'hub' : 'named', specificity: Math.max(...hit.map(specificityOf)), names: hit.map(nameWords) })
      continue
    }
    const words = nameWords(e.name).trim().split(' ')
    // (never for a possessive: "charli's room" is not any room — its owner is the part that names it)
    const head = words.length > 1 && !words.some((w) => w.endsWith("'s")) ? words[words.length - 1] : ''
    if (head.length >= FUZZY_MIN_LEN && !STOP_HEADS.has(head) && !HUB_NAMES.has(head) && text.includes(` ${head} `)) {
      out.push({ id: e.id, kind: 'fuzzy', specificity: specificityOf(head), names: [] })
    } else if (
      e.name.length >= FUZZY_MIN_LEN &&
      (e.similarity ?? 0) >= fuzzyThreshold &&
      // a TYPO shares no whole word with the text; "charli's bike" sharing "charli" is a different thing
      // that happens to contain the asked-about name, not a misspelling of it (F1 on the read side)
      !words.some((w) => text.includes(` ${w.replace(/'s$/, '')} `))
    ) {
      out.push({ id: e.id, kind: 'fuzzy', specificity: specificityOf(e.name) * (e.similarity ?? 0), names: [] })
    }
  }
  // Maximal munch: a named match whose every matched form sits inside ANOTHER entity's longer matched
  // name is only PART of what was asked ("room" in "marco's room", "sink" in "kitchen sink", the owner
  // "charli" in "charli's room") — the longer, more specific name is the subject of the question.
  const bare = (n: string) => n.replace(/'s /g, ' ')
  for (const m of out) {
    if (m.kind === 'fuzzy' || !m.names.length) continue
    const inside = m.names.every((n) => out.some((o) => o !== m && o.names.some((big) => big.length > n.length && (big.includes(n) || bare(big).includes(n)))))
    if (inside) m.kind = 'part'
  }
  const order: Record<EntityMatchKind, number> = { named: 0, hub: 1, fuzzy: 2, part: 3 }
  return out
    .sort((a, b) => order[a.kind] - order[b.kind] || b.specificity - a.specificity)
    .map(({ id, kind, specificity }) => ({ id, kind, specificity }))
}

/** Canonical predicates the question's words point at (a weak arm — "who's staying this weekend?"). */
export function cuedPredicates(text: string): string[] {
  return predicatesCuedBy(lookupWords(text), text)
}

const SAID = /\b(say|said|says|saying|mention|mentioned|mentions|tell|told|tells|write|wrote|post|posted|ask|asked)\b/

/**
 * "What did Marco say about the plumber?" → Marco's member id (F13): a say-verb plus exactly ONE
 * housemate named as whole words ("I" = the sender). Names come from the roster, never the text; an
 * ambiguous or absent name returns null (no author filter).
 */
export function askedAuthor(query: string, roster: Map<string, string>, speaker?: LookupSpeaker | null): string | null {
  const raw = wordText(query)
  if (!SAID.test(raw)) return null
  if (speaker && /\b(did|have|had) i\b/.test(raw)) return speaker.memberId
  const hits = new Set<string>()
  const firstCount = new Map<string, number>()
  for (const name of roster.values()) {
    const f = nameWords(name).trim().split(' ')[0]
    if (f) firstCount.set(f, (firstCount.get(f) ?? 0) + 1)
  }
  for (const [id, name] of roster) {
    const full = nameWords(name).trim()
    const first = full.split(' ')[0]
    if (!full) continue
    if (raw.includes(` ${full} `) || (first && firstCount.get(first) === 1 && raw.includes(` ${first} `))) hits.add(id)
  }
  return hits.size === 1 ? [...hits][0] : null
}
