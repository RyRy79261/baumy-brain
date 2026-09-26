import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANONICAL_PREDICATES, PREDICATE_SYNONYMS, cardinalityOf, normalizePredicate, normalizePredicateShape, predicateVocabulary, POSSESSOR_PREDICATE } from '@/lib/memory/predicates'
import { EXTRACT_FACTS_SYSTEM } from '@/lib/ai/prompts'

// The controlled fact vocabulary (docs/spec/chat-understanding-v2.md §7, F2/F3).
describe('predicate vocabulary', () => {
  it('normalises shape and maps synonyms to the canonical name', () => {
    expect(normalizePredicateShape('  Arrival-Date ')).toBe('arrival_date')
    expect(normalizePredicate('Arrival Date')).toBe('arrives_on')
    expect(normalizePredicate('staying_in')).toBe('stays_in')
    expect(normalizePredicate('is allergic to')).toBe('allergic_to')
    expect(normalizePredicate('arrives_on')).toBe('arrives_on')
    expect(normalizePredicate("Zosia's Favourite Tea")).toBe('zosias_favourite_tea') // unknown: shape only
  })

  it('every synonym targets a canonical predicate, and no canonical name is also a synonym', () => {
    for (const [from, to] of Object.entries(PREDICATE_SYNONYMS)) {
      expect(CANONICAL_PREDICATES[to], `${from} → ${to}`).toBeDefined()
      expect(CANONICAL_PREDICATES[from], from).toBeUndefined()
      expect(normalizePredicateShape(from)).toBe(from) // keys are stored normalised
    }
  })

  it('cardinality: multi for guests/likes/relations, single for everything else (incl. unknown)', () => {
    expect(cardinalityOf('has_guest')).toBe('multi')
    expect(cardinalityOf('allergic_to')).toBe('multi')
    expect(cardinalityOf('arrives_on')).toBe('single')
    expect(cardinalityOf('something_new')).toBe('single')
    expect(cardinalityOf(POSSESSOR_PREDICATE)).toBe('single')
  })

  it('the extractor prompt lists the vocabulary (never the structural possessor edge)', () => {
    expect(EXTRACT_FACTS_SYSTEM).toContain(predicateVocabulary())
    for (const p of ['arrives_on', 'has_guest', 'stays_in', 'allergic_to']) expect(EXTRACT_FACTS_SYSTEM).toContain(p)
    expect(predicateVocabulary()).not.toContain(POSSESSOR_PREDICATE)
  })

  it('migration 0022 renames exactly the synonym map (the SQL and the code stay in step)', () => {
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0022_normalise_fact_predicates.sql'), 'utf8')
    const whens = [...sql.matchAll(/WHEN '([a-z_]+)' THEN '([a-z_]+)'/g)].map((m) => [m[1], m[2]])
    expect(Object.fromEntries(whens)).toEqual(PREDICATE_SYNONYMS)
    const inList = sql.slice(sql.lastIndexOf(' IN ('))
    for (const k of Object.keys(PREDICATE_SYNONYMS)) expect(inList).toContain(`'${k}'`)
  })
})
