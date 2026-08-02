-- Custom SQL migration file, put your code below! --

-- Point the ask-Baumy conversational topic at the owner-chosen forum thread (docs/spec/telegram.md
-- D9c). In this topic Baumy answers freely (no @mention) and read-only introspection is handy. This
-- is a one-time seed for THIS single-house deployment; /baumyhere run inside a topic overrides it, and
-- /baumyoff clears it. Reminders keep their own topic (reminder_thread_id) — this only sets the
-- conversational channel. Idempotent.
UPDATE "baumy_house_config"
SET "console_thread_id" = 2472,
    "updated_at" = now()
WHERE "id" = true;
