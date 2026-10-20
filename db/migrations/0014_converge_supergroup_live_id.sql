-- Custom SQL migration file, put your code below! --

-- Converge this house onto its supergroup transport id + notification topic (docs/spec/telegram.md D9).
-- The group was upgraded to a topics/forum supergroup, so the live chat id is now -1009999999999 and
-- reminders should post into the notification topic (thread 2468). This is the alias seam's one-time
-- seed for THIS single-house deployment: house_group_chat_id (the memory SCOPE / group_id on every
-- row) is deliberately LEFT UNTOUCHED so no history is orphaned — only the transport id + topic move.
-- Idempotent: re-running sets the same values; migrated_from_chat_id keeps its first (real) value.
-- Only for a house that already exists: on a FRESH database (no house yet) it must do nothing, or a
-- new house would send every reminder to this one's chat (found by the e2e stack, e2e/README.md).
-- Production applied this file before the guard; drizzle never re-runs an applied migration.
UPDATE "baumy_house_config"
SET "live_chat_id" = '-1009999999999',
    "reminder_thread_id" = 2468,
    "migrated_from_chat_id" = COALESCE("migrated_from_chat_id", "house_group_chat_id"),
    "updated_at" = now()
WHERE "id" = true AND "house_group_chat_id" IS NOT NULL;
