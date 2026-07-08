CREATE TABLE "baumy_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"list_name" text DEFAULT 'shopping' NOT NULL,
	"item" text NOT NULL,
	"item_normalized" text NOT NULL,
	"added_by" text,
	"checked_by" text,
	"checked_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_added_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_checked_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baumy_list_items_group_open_idx" ON "baumy_list_items" USING btree ("group_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_list_items_open_uq" ON "baumy_list_items" USING btree ("group_id","list_name","item_normalized") WHERE "baumy_list_items"."is_active" AND "baumy_list_items"."checked_at" IS NULL;