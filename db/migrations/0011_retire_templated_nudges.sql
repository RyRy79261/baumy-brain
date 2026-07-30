-- DATA migration (no schema change) — clears the mess the old event-surfacing left behind, so the
-- fix does not need a human to remember a cleanup script. Runs once, automatically, on deploy
-- (scripts/maybe-migrate.mjs). See docs/spec/event-surfacing.md.
--
-- 1. Pending TEMPLATED heads-ups. The code no longer writes "Heads-up — <subject> <predicate>,
--    <lead>" lines, but rows already scheduled would still fire that text at the house. DELETED,
--    not cancelled: the scan de-dupes against reminders of ANY status, so a cancelled row would
--    permanently block the properly-written replacement for that event×stage. The pattern is
--    anchored to the exact old template (prefix + the ", <lead> (" tail), so a model-written line
--    that happens to open with "Heads-up" is not caught.
DELETE FROM baumy_reminders
WHERE anchor_kind = 'event_offset'
  AND status = 'scheduled'
  AND content LIKE 'Heads-up — %'
  AND (content LIKE '%, today (%' OR content LIKE '%, tomorrow (%' OR content LIKE '%, next week (%');
--> statement-breakpoint

-- 2. event_at values the old blind chrono catch-up invented. A reflect PROFILE is a prose paragraph
--    (a month name inside it is not an event date), and any fact whose value is longer than the
--    parser's 120-char limit is prose too. Nulling event_at drops them out of the surfacing query;
--    they stay perfectly good facts, they are just not events.
UPDATE baumy_facts SET event_at = NULL
WHERE event_at IS NOT NULL
  AND (predicate = 'profile' OR length(coalesce(object_value, '')) > 120);
--> statement-breakpoint

-- 3. The un-delivered backlog: reminders whose moment passed long ago but which sat 'scheduled'
--    forever, waiting for the next digest to flush them into the group as if they were today's
--    news. Cancelled, not deleted — the dashboard keeps the audit trail, and claimReminder gates
--    cancelled rows out of every delivery path. Going forward expireStaleScheduled does this on
--    every digest run; this clears what is already there.
UPDATE baumy_reminders SET status = 'cancelled'
WHERE status = 'scheduled' AND fire_at < now() - interval '24 hours';
