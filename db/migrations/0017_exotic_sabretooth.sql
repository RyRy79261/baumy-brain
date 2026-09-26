-- Conversation window (docs/spec/chat-understanding-v2.md §5). baumy_messages was reserved and never
-- written before this migration; clear any stray row so the NOT NULL columns below apply cleanly (a
-- row without text_redacted / sent_at has nothing a window read could use anyway). Hand-added.
DELETE FROM "baumy_messages";--> statement-breakpoint
ALTER TABLE "baumy_messages" ALTER COLUMN "sent_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "author_kind" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "text_redacted" text NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "trust" text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "reply_to_message_id" text;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "thread_id" bigint;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "produced_memory_item_id" uuid;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "produced_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "produced_reminder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "baumy_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_messages_chat_msg_uq" ON "baumy_messages" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "baumy_messages_chat_sent_idx" ON "baumy_messages" USING btree ("chat_id","sent_at");