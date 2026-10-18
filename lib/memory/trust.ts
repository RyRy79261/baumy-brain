import { isStructuralEdge } from '@/lib/memory/predicates'

// The trust gate — the memory-poisoning defense (memory-core #39, spec §7, F5). ONE implementation, used
// by every path that lets one fact replace another: reconcile on write (lib/memory/facts.ts) and the
// nightly hygiene replay (lib/memory/hygiene.ts). Pure recency-wins is the exact hole a planted note
// exploits; a fact may only supersede (or close) a live incumbent when its trust is >= the incumbent's.
//
// Two authenticated exceptions: the SAME author may correct their own fact from any lane, and the
// house owner may correct anything below 'system'. Identity comes from the turn (or the roster, for the
// replay), never from message text. A 'system' fact (a reflect profile) is never correctable by chat —
// except the name-derived possessor edge (isStructuralEdge): `system` only because no housemate said
// it, a default and not a statement, so any stated owner replaces it.
//
// Anything the gate refuses is the caller's to keep as a non-current CONFLICT row.

const TRUST_RANK: Record<string, number> = { system: 4, trusted: 3, untrusted: 2, forwarded: 1, quarantined: 1 }

/** Rank of a trust level for the gate; an unknown level ranks below everything. */
export const trustRank = (t: string): number => TRUST_RANK[t] ?? 0

export interface GateIncumbent {
  predicate: string
  trustLevel: string
  authoredBy: string | null
}

export interface GateChallenger {
  trustLevel: string
  authoredBy: string | null
  /** The challenger's author is the house owner (roster role, authenticated). */
  authorIsOwner?: boolean
}

/** May `challenger` supersede / close the live `incumbent`? */
export function mayOverride(challenger: GateChallenger, incumbent: GateIncumbent): boolean {
  if (isStructuralEdge(incumbent)) return true
  if (trustRank(challenger.trustLevel) >= trustRank(incumbent.trustLevel)) return true
  if (incumbent.trustLevel === 'system') return false
  if (challenger.authoredBy != null && challenger.authoredBy === incumbent.authoredBy) return true
  return challenger.authorIsOwner === true && challenger.authoredBy != null
}
