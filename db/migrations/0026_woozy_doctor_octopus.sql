ALTER TABLE "baumy_house_config" ADD COLUMN "shopping_updated_by" text;--> statement-breakpoint
ALTER TABLE "baumy_house_config" ADD COLUMN "shopping_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baumy_house_config" ADD CONSTRAINT "baumy_house_config_shopping_updated_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("shopping_updated_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;