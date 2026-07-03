import { and, desc, eq } from 'drizzle-orm'
import { type Database } from '@/db/client'
import { memoryItems, facts, entities } from '@/db/schema'

// Read-only dashboard views of what Baumy remembers. SECURITY (disclosure discretion,
// memory-core #15): a secret's plaintext is NEVER selected here — memory_items.content
// already holds only the non-secret descriptor (ciphertext lives in content_encrypted),
// and facts.object_value is NULL for secure facts (ciphertext in value_ciphertext). So
// rendering content / object_value can never leak a decrypted secret.

export async function listRecentMemories(db: Database, groupId: string, limit = 60) {
  return db
    .select({
      id: memoryItems.id,
      content: memoryItems.content,
      memoryType: memoryItems.memoryType,
      trustLevel: memoryItems.trustLevel,
      isSecure: memoryItems.isSecure,
      authoredBy: memoryItems.authoredBy,
      createdAt: memoryItems.createdAt,
    })
    .from(memoryItems)
    .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.isActive, true)))
    .orderBy(desc(memoryItems.createdAt))
    .limit(limit)
}

export async function listCurrentFacts(db: Database, groupId: string, limit = 100) {
  return db
    .select({
      id: facts.id,
      subject: entities.canonicalName,
      predicate: facts.predicate,
      objectValue: facts.objectValue, // NULL when secure — never the ciphertext
      isSecure: facts.isSecure,
      trustLevel: facts.trustLevel,
      recordedAt: facts.recordedAt,
    })
    .from(facts)
    .innerJoin(entities, eq(facts.subjectEntityId, entities.id))
    .where(and(eq(facts.groupId, groupId), eq(facts.isCurrent, true)))
    .orderBy(desc(facts.recordedAt))
    .limit(limit)
}
