import { and, desc, eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { entities, facts } from '@/db/schema'
import { encryptSecret } from '@/lib/core/crypto'
import { scanSensitivity } from '@/lib/core/sensitivity'
import type { Trust } from '@/lib/core/origin'

// Trust ranking for contradiction resolution. A fact may only supersede an
// existing one when its trust is >= the incumbent's (memory-core #39). This is
// the memory-poisoning defense: pure recency-wins is the exact hole a planted
// note exploits; trust-gating closes it.
const TRUST_RANK: Record<string, number> = { system: 4, trusted: 3, untrusted: 2, quarantined: 1 }
const rank = (t: string): number => TRUST_RANK[t] ?? 0

export interface ExtractedFact {
  subject: string
  predicate: string
  object: string
}
export type ReconcileResult = 'add' | 'noop' | 'update' | 'rejected'

async function upsertEntity(db: Database, groupId: string, name: string): Promise<string> {
  const canonical = name.trim().toLowerCase()
  const [existing] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.groupId, groupId), eq(entities.canonicalName, canonical)))
    .limit(1)
  if (existing) return existing.id
  const [row] = await db
    .insert(entities)
    .values({ groupId, kind: 'thing', canonicalName: canonical })
    .returning({ id: entities.id })
  return row.id
}

// Reconcile one extracted fact into the knowledge graph: ADD (new subject+
// predicate), NOOP (unchanged), UPDATE (soft-supersede on a trust-permitted
// contradiction), or REJECTED (quarantined origin, or a lower-trust fact trying
// to overwrite a higher-trust one).
export async function reconcileFact(
  db: Database,
  input: { groupId: string; fact: ExtractedFact; authoredBy: string | null; trustLevel: Trust },
): Promise<ReconcileResult> {
  // Quarantined (forwarded/bot) content NEVER becomes a fact (injection wall #7).
  if (input.trustLevel === 'quarantined') return 'rejected'

  const subjectId = await upsertEntity(db, input.groupId, input.fact.subject)
  const predicate = input.fact.predicate.trim().toLowerCase()

  // Secure-value detection considers the whole triple (the secret marker usually
  // lives in the subject/predicate, e.g. "wifi password"), then encrypts the value.
  const sens = scanSensitivity(`${input.fact.subject} ${input.fact.predicate} ${input.fact.object}`)
  const isSecure = sens.isSecure
  const objectValue = isSecure ? null : input.fact.object
  const valueCiphertext = isSecure ? encryptSecret(input.fact.object) : null

  const newValues = {
    groupId: input.groupId,
    subjectEntityId: subjectId,
    predicate,
    objectValue,
    isSecure,
    valueCiphertext,
    keyVersion: isSecure ? 1 : null,
    authoredBy: input.authoredBy,
    trustLevel: input.trustLevel,
    validFrom: new Date(),
    isCurrent: true,
  }

  const [existing] = await db
    .select({ id: facts.id, objectValue: facts.objectValue, isSecure: facts.isSecure, trustLevel: facts.trustLevel })
    .from(facts)
    .where(
      and(
        eq(facts.groupId, input.groupId),
        eq(facts.subjectEntityId, subjectId),
        eq(facts.predicate, predicate),
        eq(facts.isCurrent, true),
      ),
    )
    .limit(1)

  if (!existing) {
    await db.insert(facts).values(newValues)
    return 'add'
  }

  // Unchanged non-secret value → nothing to do.
  if (!isSecure && !existing.isSecure && existing.objectValue === objectValue) return 'noop'

  // Contradiction: only a fact of >= trust may overwrite the incumbent.
  if (rank(input.trustLevel) < rank(existing.trustLevel)) return 'rejected'

  const [inserted] = await db.insert(facts).values(newValues).returning({ id: facts.id })
  await db
    .update(facts)
    .set({ isCurrent: false, supersededBy: inserted.id, validTo: new Date(), invalidatedAt: new Date() })
    .where(eq(facts.id, existing.id))
  return 'update'
}

// Current facts whose subject is named in the query — a lightweight structured
// lookup that the reply path unions with semantic recall. Secure values stay
// encrypted here (decrypted only in the reply, to answer a direct request).
export async function currentFactsForQuery(
  db: Database,
  groupId: string,
  query: string,
  limit = 5,
): Promise<Array<{ content: string; isSecure: boolean; contentEncrypted: string | null }>> {
  const rows = await db
    .select({
      subject: entities.canonicalName,
      predicate: facts.predicate,
      objectValue: facts.objectValue,
      isSecure: facts.isSecure,
      valueCiphertext: facts.valueCiphertext,
    })
    .from(facts)
    .innerJoin(entities, eq(facts.subjectEntityId, entities.id))
    .where(and(eq(facts.groupId, groupId), eq(facts.isCurrent, true)))
    .orderBy(desc(facts.recordedAt))
    .limit(50)

  const q = query.toLowerCase()
  return rows
    .filter((r) => r.subject && q.includes(r.subject))
    .slice(0, limit)
    .map((r) => ({
      content: `${r.subject} ${r.predicate.replace(/_/g, ' ')}${r.isSecure ? '' : `: ${r.objectValue ?? ''}`}`,
      isSecure: r.isSecure,
      contentEncrypted: r.valueCiphertext,
    }))
}
