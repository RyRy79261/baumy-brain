import { describe, it, expect } from 'vitest'
import { mayOverride, trustRank, type GateChallenger, type GateIncumbent } from '@/lib/memory/trust'
import { POSSESSOR_PREDICATE } from '@/lib/memory/predicates'

// The trust gate (spec §7, F5) — the ONE rule reconcile (write) and the hygiene replay both apply.
const inc = (trustLevel: string, authoredBy: string | null = 'marco', predicate = 'stays_in'): GateIncumbent => ({ predicate, trustLevel, authoredBy })
const ch = (trustLevel: string, authoredBy: string | null = 'chloe', authorIsOwner = false): GateChallenger => ({ trustLevel, authoredBy, authorIsOwner })

describe('trust gate', () => {
  it('ranks system > trusted > untrusted > relayed, unknown lowest', () => {
    expect(trustRank('system')).toBeGreaterThan(trustRank('trusted'))
    expect(trustRank('trusted')).toBeGreaterThan(trustRank('untrusted'))
    expect(trustRank('untrusted')).toBeGreaterThan(trustRank('forwarded'))
    expect(trustRank('forwarded')).toBe(trustRank('quarantined'))
    expect(trustRank('nonsense')).toBeLessThan(trustRank('quarantined'))
  })

  it.each([
    // [challenger, incumbent, may?, why]
    [ch('trusted'), inc('untrusted'), true, 'higher trust wins'],
    [ch('untrusted'), inc('untrusted'), true, 'equal trust wins (newest)'],
    [ch('untrusted'), inc('trusted'), false, 'lower trust is a conflict — the poisoning defense'],
    [ch('untrusted', 'marco'), inc('trusted', 'marco'), true, 'same author corrects own fact from any lane'],
    [ch('untrusted', 'chloe', true), inc('trusted', 'marco'), true, 'owner corrects below system'],
    [ch('trusted', 'chloe', true), inc('system', null), false, 'nobody corrects a system fact by chat'],
    [ch('trusted', 'marco'), inc('system', 'marco'), false, 'not even its "author"'],
    [ch('untrusted', null, true), inc('trusted', 'marco'), false, 'owner flag without an author is not an owner'],
    [ch('untrusted', null), inc('trusted', null), false, 'two anonymous rows are not "the same author"'],
    [ch('untrusted'), inc('system', null, POSSESSOR_PREDICATE), true, 'the structural possessor edge is a default — any statement replaces it'],
    [ch('untrusted'), inc('system', 'marco', POSSESSOR_PREDICATE), false, 'a stated belongs_to at system trust is not structural'],
  ] as const)('%#: %s', (challenger, incumbent, may, why) => {
    expect(mayOverride(challenger, incumbent), why).toBe(may)
  })
})
