-- Issue #25 (the live shopping list): a bought item now stays on the list, ticked, until someone taps
-- "Clear done". Items bought BEFORE the live list existed are history, not a list waiting to be
-- cleared, so they are marked cleared at the moment they were bought. Idempotent: a row that already
-- has cleared_at is never touched again, so a re-run changes nothing.
UPDATE "baumy_list_items" SET "cleared_at" = "checked_at" WHERE "checked_at" IS NOT NULL AND "cleared_at" IS NULL;
