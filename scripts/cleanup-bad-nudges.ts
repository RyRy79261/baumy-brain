// One-off cleanup for the heads-up mess (see docs/spec/event-surfacing.md).
// Three things the code fixes going forward, but which are already sitting in the DB:
//   1. reminders still 'scheduled' with a long-past fire time — the backlog the digest was
//      flushing into the group as if it were today's news;
//   2. event_at values invented by the old blind chrono catch-up — most visibly on reflect
//      PROFILE facts (a paragraph is not an event);
//   3. the templated "Heads-up — <subject> <predicate>, today" reminders those produced. These are
//      DELETED, not cancelled: the scan de-dupes against reminders of ANY status, so a cancelled
//      row would block the properly-written replacement from ever being scheduled.
//
// Run:  node --experimental-strip-types scripts/cleanup-bad-nudges.ts          (dry run — prints)
//       node --experimental-strip-types scripts/cleanup-bad-nudges.ts --yes    (apply)
// Needs: DATABASE_URL (pooled is fine — every statement is standalone).

export {} // module scope (isolates top-level names from other scripts under tsc)

const apply = process.argv.includes('--yes')
const STALE_HOURS = 24

if (!process.env.DATABASE_URL) {
  console.error('Missing env: DATABASE_URL')
  process.exit(1)
}

// Raw neon-http (not db/client) so the script runs standalone under
// `node --experimental-strip-types`, with no path-alias resolution to set up.
const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL)
const rowsOf = (res: unknown): Record<string, unknown>[] => (Array.isArray(res) ? (res as Record<string, unknown>[]) : [])

const staleCutoff = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString()

// 1 — the un-delivered backlog.
const stale = rowsOf(
  await sql`
    SELECT id, content, fire_at FROM baumy_reminders
    WHERE status = 'scheduled' AND fire_at < ${staleCutoff}
    ORDER BY fire_at`,
)

// 2 — dates the blind catch-up invented. Profiles can never be events; the rest are current dated
// facts whose value is prose (too long to be a date phrase), which is what the parser now rejects.
const badDates = rowsOf(
  await sql`
    SELECT id, predicate, left(coalesce(object_value, ''), 60) AS value, event_at FROM baumy_facts
    WHERE is_current = true AND event_at IS NOT NULL
      AND (predicate = 'profile' OR length(coalesce(object_value, '')) > 120)
    ORDER BY event_at`,
)

// 3 — heads-ups still pending from the old template.
const templated = rowsOf(
  await sql`
    SELECT id, content FROM baumy_reminders
    WHERE anchor_kind = 'event_offset' AND status = 'scheduled' AND content LIKE 'Heads-up —%'
    ORDER BY fire_at`,
)

console.log(`stale scheduled reminders (>${STALE_HOURS}h past due): ${stale.length}`)
for (const r of stale.slice(0, 20)) console.log(`  · ${String(r.fire_at)}  ${String(r.content).slice(0, 70)}`)
if (stale.length > 20) console.log(`  … and ${stale.length - 20} more`)
console.log(`facts carrying an invented event_at: ${badDates.length}`)
for (const f of badDates.slice(0, 20)) console.log(`  · ${String(f.event_at)}  [${String(f.predicate)}] ${String(f.value)}`)
console.log(`pending template heads-ups to delete: ${templated.length}`)
for (const r of templated.slice(0, 20)) console.log(`  · ${String(r.content).slice(0, 70)}`)

if (!apply) {
  console.log('\nDRY RUN — nothing changed. Re-run with --yes to apply.')
  process.exit(0)
}

// Cancel (not delete) the backlog: keeps the audit trail, and claimReminder gates cancelled rows
// out of every delivery path.
await sql`UPDATE baumy_reminders SET status = 'cancelled' WHERE status = 'scheduled' AND fire_at < ${staleCutoff}`
await sql`
  UPDATE baumy_facts SET event_at = NULL
  WHERE is_current = true AND event_at IS NOT NULL
    AND (predicate = 'profile' OR length(coalesce(object_value, '')) > 120)`
await sql`DELETE FROM baumy_reminders WHERE anchor_kind = 'event_offset' AND status = 'scheduled' AND content LIKE 'Heads-up —%'`

console.log('\nDone. The next 08:00 scan re-writes any heads-up that is still a real event.')
