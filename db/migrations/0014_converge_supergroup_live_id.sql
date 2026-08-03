-- Custom SQL migration file, put your code below! --

-- Converge this house onto its supergroup transport id + notification topic (docs/spec/telegram.md D9).
-- The group was upgraded to a topics/forum supergroup, so the live chat id is now -1002306637555 and
-- reminders should post into the notification topic (thread 2468). This is the alias seam's one-time
-- seed for THIS single-house deployment: house_group_chat_id (the memory SCOPE / group_id on every
-- row) is deliberately LEFT UNTOUCHED so no history is orphaned — only the transport id + topic move.
-- Idempotent: re-running sets the same values; migrated_from_chat_id keeps its first (real) value.
UPDATE "baumy_house_config"
SET "live_chat_id" = '-1002306637555',
    "reminder_thread_id" = 2468,
    "migrated_from_chat_id" = COALESCE("migrated_from_chat_id", "house_group_chat_id"),
    "updated_at" = now()
WHERE "id" = true;
