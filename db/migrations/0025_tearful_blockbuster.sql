ALTER TABLE "baumy_list_items" ADD COLUMN "removed_by" text;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "renamed_by" text;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "renamed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_removed_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_renamed_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("renamed_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;