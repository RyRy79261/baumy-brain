// The fact vocabulary (docs/spec/chat-understanding-v2.md §7, F2/F3). The extractor names predicates
// freely per message, and supersession is keyed on (subject, predicate) — so "arrival_date: saturday"
// never corrected "arrives_on: friday" (both stayed current, F3), and a second guest overwrote the
// first because nothing knew `has_guest` can hold several values at once (F2).
//
// This module is THE vocabulary: canonical predicates with a cardinality, and a synonym table for
// the drift the model produces. The extractor prompt lists the canonical names (lib/ai/prompts.ts);
// reconcile normalises whatever comes back (lib/memory/facts.ts) and reads the cardinality:
//   single — one live value per (subject, predicate); a different value supersedes (trust-gated).
//   multi  — values accumulate; only a `removes` flag ("X is no longer staying") closes one.
// An unknown predicate is normalised (snake_case, synonym-mapped) and treated single-valued — the
// pre-v2 behaviour, so nothing that worked before starts accumulating contradictions.
//
// Migration 0022 renamed existing rows through PREDICATE_SYNONYMS (a unit test keeps the two in step);
// the nightly hygiene sweep (lib/memory/hygiene.ts) re-normalises anything written since.

export type Cardinality = 'single' | 'multi'

interface PredicateDef {
  cardinality: Cardinality
  /** One line for the extractor prompt: what the predicate means. */
  gloss: string
  /** Question words that point at this predicate ("who's STAYING" → has_guest / stays_in) — a weak
   *  recall arm for the direct fact lookup when the question names no subject (lib/memory/lookup.ts). */
  cues?: string[]
}

export const CANONICAL_PREDICATES: Record<string, PredicateDef> = {
  // ── single-valued: one live value; a new one supersedes ─────────────────────────────────────────
  arrives_on: { cardinality: 'single', gloss: 'when someone arrives', cues: ['arrive', 'arrives', 'arriving', 'arrival', 'land', 'lands', 'landing', 'coming'] },
  leaves_on: { cardinality: 'single', gloss: 'when someone leaves', cues: ['leave', 'leaves', 'leaving', 'departure', 'depart', 'going home'] },
  stays_in: { cardinality: 'single', gloss: 'the room/place a person is staying or sleeping in', cues: ['staying', 'sleeping', 'stays', 'sleeps', 'crashing'] },
  is_away: { cardinality: 'single', gloss: 'a person is away (value: where/until when)', cues: ['away', 'around', 'home', 'back'] },
  location: { cardinality: 'single', gloss: 'where a thing or person currently is', cues: ['where'] },
  status: { cardinality: 'single', gloss: 'the state of a thing (broken, fixed, full, booked…)', cues: ['broken', 'fixed', 'working', 'status'] },
  password: { cardinality: 'single', gloss: 'a password (wifi, account)', cues: ['password'] },
  code: { cardinality: 'single', gloss: 'a door/lock/alarm code or PIN', cues: ['code', 'pin'] },
  phone: { cardinality: 'single', gloss: 'a phone number', cues: ['phone', 'number'] },
  birthday: { cardinality: 'single', gloss: "a person's birthday", cues: ['birthday'] },
  lives_in: { cardinality: 'single', gloss: 'where a person lives (city, room of the house)', cues: ['lives'] },
  job: { cardinality: 'single', gloss: "a person's job or occupation", cues: ['job', 'work', 'works'] },
  collection_day: { cardinality: 'single', gloss: 'when bins/recycling are collected or go out', cues: ['bins', 'bin', 'recycling', 'rubbish', 'trash', 'collection'] },
  belongs_to: { cardinality: 'single', gloss: 'who a thing/room belongs to (object: the owner)' },
  // ── multi-valued: values accumulate ─────────────────────────────────────────────────────────────
  has_guest: { cardinality: 'multi', gloss: 'a guest staying with the house or a person (object: the guest)', cues: ['guest', 'guests', 'staying', 'visiting', 'visitor', 'visitors', 'visit'] },
  likes: { cardinality: 'multi', gloss: 'something a person likes', cues: ['like', 'likes', 'love', 'loves'] },
  dislikes: { cardinality: 'multi', gloss: 'something a person dislikes', cues: ['dislike', 'dislikes', 'hate', 'hates'] },
  owns: { cardinality: 'multi', gloss: 'something a person owns', cues: ['owns', 'own'] },
  allergic_to: { cardinality: 'multi', gloss: 'an allergy', cues: ['allergic', 'allergy', 'allergies'] },
  sibling_of: { cardinality: 'multi', gloss: 'a sibling (object: the other person)', cues: ['sister', 'brother', 'sibling'] },
  partner_of: { cardinality: 'multi', gloss: 'a partner (object: the other person)', cues: ['partner', 'girlfriend', 'boyfriend', 'wife', 'husband'] },
  friend_of: { cardinality: 'multi', gloss: 'a friend (object: the other person)', cues: ['friend'] },
  member_of: { cardinality: 'multi', gloss: 'a group/club/band a person belongs to' },
}

// Drift → canonical. Keys are already normalised (normalizePredicateShape). Kept conservative: a
// mapping here MERGES two supersession chains, so only true synonyms belong — "works_at" (employer)
// is not "job", and a bare "has" is far too vague to mean "owns".
export const PREDICATE_SYNONYMS: Record<string, string> = {
  arrival_date: 'arrives_on',
  arrival: 'arrives_on',
  arrives: 'arrives_on',
  arriving: 'arrives_on',
  arriving_on: 'arrives_on',
  eta: 'arrives_on',
  lands_on: 'arrives_on',
  coming_on: 'arrives_on',
  departure_date: 'leaves_on',
  departure: 'leaves_on',
  departs_on: 'leaves_on',
  leaves: 'leaves_on',
  leaving: 'leaves_on',
  leaving_on: 'leaves_on',
  staying_in: 'stays_in',
  staying_at: 'stays_in',
  sleeping_in: 'stays_in',
  sleeps_in: 'stays_in',
  stays_at: 'stays_in',
  is_staying_in: 'stays_in',
  away: 'is_away',
  away_until: 'is_away',
  is_away_until: 'is_away',
  located_in: 'location',
  located_at: 'location',
  has_password: 'password',
  wifi_password: 'password',
  door_code: 'code',
  pin: 'code',
  phone_number: 'phone',
  mobile: 'phone',
  birth_date: 'birthday',
  born_on: 'birthday',
  lives_at: 'lives_in',
  occupation: 'job',
  works_as: 'job',
  bin_day: 'collection_day',
  collected_on: 'collection_day',
  pickup_day: 'collection_day',
  go_out: 'collection_day',
  goes_out: 'collection_day',
  owned_by: 'belongs_to',
  guest: 'has_guest',
  has_visitor: 'has_guest',
  visitor: 'has_guest',
  hosting: 'has_guest',
  loves: 'likes',
  enjoys: 'likes',
  hates: 'dislikes',
  allergy: 'allergic_to',
  is_allergic_to: 'allergic_to',
  sister_of: 'sibling_of',
  brother_of: 'sibling_of',
  is_sibling_of: 'sibling_of',
  girlfriend_of: 'partner_of',
  boyfriend_of: 'partner_of',
  wife_of: 'partner_of',
  husband_of: 'partner_of',
  friends_with: 'friend_of',
  is_friend_of: 'friend_of',
}

/** The structural edge "charli's bike —belongs_to→ charli", recorded when a possessive entity is
 *  created (F1) — deterministic from the name, so stored at 'system' trust with no author. */
export const POSSESSOR_PREDICATE = 'belongs_to'

/** That name-derived edge itself (not a housemate's "X belongs to Y"): `system` trust, no author. It is
 *  a default, not a statement — any stated owner replaces it (the trust gate and the hygiene replay let
 *  a non-relayed statement through), and it is never a lookup hit or a forget detail. */
export const isStructuralEdge = (r: { predicate: string; trustLevel: string; authoredBy: string | null }) =>
  r.predicate === POSSESSOR_PREDICATE && r.trustLevel === 'system' && r.authoredBy == null

// Shape only: lowercase snake_case ("Arrival Date" / "arrival-date" → arrival_date).
export function normalizePredicateShape(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return s || raw.trim().toLowerCase()
}

/** The canonical predicate for whatever the model wrote (spec §7). Unknown names stay as-is
 *  (normalised), which reconcile treats as single-valued. */
export function normalizePredicate(raw: string): string {
  const s = normalizePredicateShape(raw)
  if (CANONICAL_PREDICATES[s]) return s
  if (PREDICATE_SYNONYMS[s]) return PREDICATE_SYNONYMS[s]
  return s
}

export function cardinalityOf(predicate: string): Cardinality {
  return CANONICAL_PREDICATES[predicate]?.cardinality ?? 'single'
}

/** Canonical predicates whose cue words appear (whole-word) in a lookup text — lib/memory/lookup.ts. */
export function predicatesCuedBy(words: Set<string>, text: string): string[] {
  return Object.entries(CANONICAL_PREDICATES)
    .filter(([, d]) => (d.cues ?? []).some((c) => (c.includes(' ') ? text.includes(` ${c} `) : words.has(c))))
    .map(([p]) => p)
}

/** The vocabulary as the extractor prompt lists it. */
export function predicateVocabulary(): string {
  const line = (card: Cardinality) =>
    Object.entries(CANONICAL_PREDICATES)
      .filter(([p, d]) => d.cardinality === card && p !== POSSESSOR_PREDICATE)
      .map(([p, d]) => `${p} (${d.gloss})`)
      .join('; ')
  return `ONE value at a time: ${line('single')}. SEVERAL values at once: ${line('multi')}.`
}
