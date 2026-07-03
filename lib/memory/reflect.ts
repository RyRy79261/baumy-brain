import { sql } from 'drizzle-orm'
import { type Database } from '@/db/client'
import type { ReflectFact, ReflectNote } from '@/lib/ai/reflect'

// The predicate under which a reflected profile is stored. A profile is just another
// fact (subject=person, predicate='profile'), so reconcileFact supersedes the old one
// for free and retrieval surfaces it — but it's excluded from the material we reflect
// ON (we don't reflect a profile back onto itself).
export const PROFILE_PREDICATE = 'profile'

// Minimum current facts a person needs before a profile is worth synthesising — below
// this there's nothing to consolidate.
const MIN_FACTS = 2

function rowsOf(res: unknown): Record<string, unknown>[] {
  return Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? [])
}

// People worth (re-)reflecting this run: person entities with >= MIN_FACTS current,
// non-secret facts AND fresh activity since their last profile — i.e. their newest
// non-profile fact is newer than their newest profile fact (or they have no profile
// yet). This is the "only reflect what changed" gate: an unchanged person is skipped,
// so the cron doesn't churn identical profiles every run.
export async function pickPeopleToReflect(
  db: Database,
  groupId: string,
  limit: number,
): Promise<Array<{ id: string; name: string }>> {
  const res = await db.execute(sql`
    SELECT e.id, e.canonical_name AS name
    FROM baumy_entities e
    WHERE e.group_id = ${groupId} AND e.kind = 'person' AND e.is_active = true
      AND (
        SELECT count(*) FROM baumy_facts f
        WHERE f.subject_entity_id = e.id AND f.is_current AND NOT f.is_secure AND f.predicate <> ${PROFILE_PREDICATE}
      ) >= ${MIN_FACTS}
      AND (
        SELECT max(f.recorded_at) FROM baumy_facts f
        WHERE f.subject_entity_id = e.id AND f.is_current AND f.predicate <> ${PROFILE_PREDICATE}
      ) > coalesce((
        SELECT max(f.recorded_at) FROM baumy_facts f
        WHERE f.subject_entity_id = e.id AND f.is_current AND f.predicate = ${PROFILE_PREDICATE}
      ), '1970-01-01'::timestamptz)
    ORDER BY e.canonical_name
    LIMIT ${limit}`)
  return rowsOf(res).map((r) => ({ id: String(r.id), name: String(r.name) }))
}

// The material to reflect on for one person: their current, NON-SECRET facts (a secret
// value is never fed to synthesis — it must never leak into a profile / digest) plus the
// attributed notes filed under them, EXCLUDING quarantined (forwarded/bot) content. Note
// authors are resolved to display names so sentiment stays attributed ("Ryan: …").
export async function gatherPersonMaterial(
  db: Database,
  groupId: string,
  personId: string,
): Promise<{ facts: ReflectFact[]; notes: ReflectNote[] }> {
  const factRes = await db.execute(sql`
    SELECT f.predicate, f.object_value AS value
    FROM baumy_facts f
    WHERE f.group_id = ${groupId} AND f.subject_entity_id = ${personId}
      AND f.is_current AND NOT f.is_secure AND f.predicate <> ${PROFILE_PREDICATE}
      AND f.object_value IS NOT NULL AND length(f.object_value) > 0
    ORDER BY f.recorded_at DESC
    LIMIT 40`)
  const facts: ReflectFact[] = rowsOf(factRes).map((r) => ({ predicate: String(r.predicate), value: String(r.value) }))

  const noteRes = await db.execute(sql`
    SELECT mi.content, m.display_name AS by
    FROM baumy_memory_items mi
    LEFT JOIN baumy_members m ON mi.authored_by = m.telegram_user_id
    WHERE mi.group_id = ${groupId} AND mi.about_entity_id = ${personId}
      AND mi.is_active AND NOT mi.is_secure AND mi.trust_level <> 'quarantined'
    ORDER BY mi.salience DESC, mi.created_at DESC
    LIMIT 20`)
  const notes: ReflectNote[] = rowsOf(noteRes).map((r) => ({
    text: String(r.content),
    by: (r.by ?? null) as string | null,
  }))

  return { facts, notes }
}
