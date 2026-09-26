-- Custom SQL migration file, put your code below! --

-- Normalise LEGACY fact predicates (docs/spec/chat-understanding-v2.md §7, F3). Before the controlled
-- vocabulary (lib/memory/predicates.ts) the extractor named predicates freely, so one chain of truth
-- was split across synonyms ("arrives_on" + "arrival_date") and a correction under one never
-- superseded the other. This renames every row — live, superseded or forgotten — through
-- PREDICATE_SYNONYMS (a unit test, lib/memory/__tests__/predicates.test.ts, keeps this list and the map
-- in step), after the same shape normalisation the code applies (lowercase snake_case, apostrophes
-- dropped).
--
-- What it does NOT do: resolve the duplicates the rename exposes (two LIVE rows for one single-valued
-- (subject, predicate)). Picking the survivor needs the trust gate + authorship rules, so the nightly
-- hygiene sweep (lib/memory/hygiene.ts) does it on its first run. Idempotent: canonical names map to
-- themselves and are never in the list.
UPDATE "baumy_facts"
SET "predicate" = CASE trim(both '_' from lower(regexp_replace(replace(trim("predicate"), '''', ''), '[^a-zA-Z0-9]+', '_', 'g')))
  WHEN 'arrival_date' THEN 'arrives_on'
  WHEN 'arrival' THEN 'arrives_on'
  WHEN 'arrives' THEN 'arrives_on'
  WHEN 'arriving' THEN 'arrives_on'
  WHEN 'arriving_on' THEN 'arrives_on'
  WHEN 'eta' THEN 'arrives_on'
  WHEN 'lands_on' THEN 'arrives_on'
  WHEN 'coming_on' THEN 'arrives_on'
  WHEN 'departure_date' THEN 'leaves_on'
  WHEN 'departure' THEN 'leaves_on'
  WHEN 'departs_on' THEN 'leaves_on'
  WHEN 'leaves' THEN 'leaves_on'
  WHEN 'leaving' THEN 'leaves_on'
  WHEN 'leaving_on' THEN 'leaves_on'
  WHEN 'staying_in' THEN 'stays_in'
  WHEN 'staying_at' THEN 'stays_in'
  WHEN 'sleeping_in' THEN 'stays_in'
  WHEN 'sleeps_in' THEN 'stays_in'
  WHEN 'stays_at' THEN 'stays_in'
  WHEN 'is_staying_in' THEN 'stays_in'
  WHEN 'away' THEN 'is_away'
  WHEN 'away_until' THEN 'is_away'
  WHEN 'is_away_until' THEN 'is_away'
  WHEN 'located_in' THEN 'location'
  WHEN 'located_at' THEN 'location'
  WHEN 'has_password' THEN 'password'
  WHEN 'wifi_password' THEN 'password'
  WHEN 'door_code' THEN 'code'
  WHEN 'pin' THEN 'code'
  WHEN 'phone_number' THEN 'phone'
  WHEN 'mobile' THEN 'phone'
  WHEN 'birth_date' THEN 'birthday'
  WHEN 'born_on' THEN 'birthday'
  WHEN 'lives_at' THEN 'lives_in'
  WHEN 'occupation' THEN 'job'
  WHEN 'works_as' THEN 'job'
  WHEN 'bin_day' THEN 'collection_day'
  WHEN 'collected_on' THEN 'collection_day'
  WHEN 'pickup_day' THEN 'collection_day'
  WHEN 'go_out' THEN 'collection_day'
  WHEN 'goes_out' THEN 'collection_day'
  WHEN 'owned_by' THEN 'belongs_to'
  WHEN 'guest' THEN 'has_guest'
  WHEN 'has_visitor' THEN 'has_guest'
  WHEN 'visitor' THEN 'has_guest'
  WHEN 'hosting' THEN 'has_guest'
  WHEN 'loves' THEN 'likes'
  WHEN 'enjoys' THEN 'likes'
  WHEN 'hates' THEN 'dislikes'
  WHEN 'allergy' THEN 'allergic_to'
  WHEN 'is_allergic_to' THEN 'allergic_to'
  WHEN 'sister_of' THEN 'sibling_of'
  WHEN 'brother_of' THEN 'sibling_of'
  WHEN 'is_sibling_of' THEN 'sibling_of'
  WHEN 'girlfriend_of' THEN 'partner_of'
  WHEN 'boyfriend_of' THEN 'partner_of'
  WHEN 'wife_of' THEN 'partner_of'
  WHEN 'husband_of' THEN 'partner_of'
  WHEN 'friends_with' THEN 'friend_of'
  WHEN 'is_friend_of' THEN 'friend_of'
END
WHERE trim(both '_' from lower(regexp_replace(replace(trim("predicate"), '''', ''), '[^a-zA-Z0-9]+', '_', 'g'))) IN (
  'arrival_date', 'arrival', 'arrives', 'arriving', 'arriving_on', 'eta', 'lands_on', 'coming_on', 'departure_date', 'departure', 'departs_on', 'leaves', 'leaving', 'leaving_on', 'staying_in', 'staying_at', 'sleeping_in', 'sleeps_in', 'stays_at', 'is_staying_in', 'away', 'away_until', 'is_away_until', 'located_in', 'located_at', 'has_password', 'wifi_password', 'door_code', 'pin', 'phone_number', 'mobile', 'birth_date', 'born_on', 'lives_at', 'occupation', 'works_as', 'bin_day', 'collected_on', 'pickup_day', 'go_out', 'goes_out', 'owned_by', 'guest', 'has_visitor', 'visitor', 'hosting', 'loves', 'enjoys', 'hates', 'allergy', 'is_allergic_to', 'sister_of', 'brother_of', 'is_sibling_of', 'girlfriend_of', 'boyfriend_of', 'wife_of', 'husband_of', 'friends_with', 'is_friend_of'
);
--> statement-breakpoint
-- Drop the FALSE lineage parents the old reconcile wrote (§7, F8): on an add it linked a fact to "the
-- most recent fact about the same subject", whatever its predicate — "wifi provider (follows from —
-- bin day)". Lineage is now only a supersession or a new occurrence of the SAME key, so after the rename
-- above a parent with a different predicate is exactly such a false link. (The read side also never
-- joins a forgotten parent any more; this cleans the stored pointer.)
UPDATE "baumy_facts" f
SET "derived_from_fact_id" = NULL
WHERE f."derived_from_fact_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "baumy_facts" p WHERE p."id" = f."derived_from_fact_id" AND p."predicate" = f."predicate"
  );
