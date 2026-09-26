-- Conversation window, part 2: the never-written verbatim `text` column is replaced by text_redacted
-- (a secret is never persisted — spec §5). Split from 0017 so drizzle-kit never had to guess a rename.
ALTER TABLE "baumy_messages" DROP COLUMN "text";