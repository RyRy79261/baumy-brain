-- Custom SQL migration file, put your code below! --

-- Close LEGACY dated facts (docs/spec/chat-understanding-v2.md §6, T2). Before the time model,
-- valid_to was written only when a row was CLOSED (superseded / forgotten, together with
-- is_current = false), so every live dated fact already in the database has event_at set and
-- valid_to NULL — and "current" (lib/memory/current.ts liveFact: valid_to IS NULL OR valid_to > now)
-- would read a March visit as still going on in September. This gives those rows the end capture
-- now writes (lib/core/when.ts): an all-day event (a local-midnight start) ends at the end of that
-- local day, a timed one lasts DEFAULT_EVENT_HOURS (6h).
--
-- The zone is Europe/Berlin — the BAUMY_TIMEZONE default and the zone every cron is pinned to
-- (SQL cannot read the env). Idempotent: it only touches rows whose valid_to is still NULL, and every
-- write path since the time model sets valid_to together with event_at — except a past-dated state
-- change (facts.ts: "fixed yesterday" over "broken"), which keeps valid_to NULL on purpose and did not
-- exist before this migration.
UPDATE "baumy_facts"
SET "valid_to" = CASE
  WHEN ("event_at" AT TIME ZONE 'Europe/Berlin')::time = time '00:00'
    THEN (((("event_at" AT TIME ZONE 'Europe/Berlin')::date + 1)::timestamp) AT TIME ZONE 'Europe/Berlin') - interval '1 millisecond'
  ELSE "event_at" + interval '6 hours'
END
WHERE "is_current" = true AND "event_at" IS NOT NULL AND "valid_to" IS NULL;
