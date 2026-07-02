ALTER TABLE "baumy_memory_items" ADD COLUMN "is_secure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_memory_items" ADD COLUMN "content_encrypted" text;