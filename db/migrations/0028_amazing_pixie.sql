CREATE TABLE "baumy_list_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"list_name" text DEFAULT 'shopping' NOT NULL,
	"item_normalized" text NOT NULL,
	"category" text NOT NULL,
	"picked_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baumy_list_categories_category_ck" CHECK ("baumy_list_categories"."category" IN ('pantry', 'fresh', 'coffee', 'cleaning', 'maintenance', 'household'))
);
--> statement-breakpoint
CREATE TABLE "baumy_list_item_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"list_name" text DEFAULT 'shopping' NOT NULL,
	"item_normalized" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "baumy_house_config" ADD COLUMN "shopping_sort" text DEFAULT 'groups' NOT NULL;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "category_source" text;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "categorized_by" text;--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD COLUMN "categorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "baumy_list_categories" ADD CONSTRAINT "baumy_list_categories_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_list_categories" ADD CONSTRAINT "baumy_list_categories_picked_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_list_item_embeddings" ADD CONSTRAINT "baumy_list_item_embeddings_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_list_categories_item_uq" ON "baumy_list_categories" USING btree ("group_id","list_name","item_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_list_item_embeddings_item_model_uq" ON "baumy_list_item_embeddings" USING btree ("group_id","list_name","item_normalized","model");--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_categorized_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("categorized_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_house_config" ADD CONSTRAINT "baumy_house_config_shopping_sort_ck" CHECK ("baumy_house_config"."shopping_sort" IN ('groups', 'az', 'added'));--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_category_ck" CHECK ("baumy_list_items"."category" IS NULL OR "baumy_list_items"."category" IN ('pantry', 'fresh', 'coffee', 'cleaning', 'maintenance', 'household'));--> statement-breakpoint
ALTER TABLE "baumy_list_items" ADD CONSTRAINT "baumy_list_items_category_source_ck" CHECK ("baumy_list_items"."category_source" IS NULL OR "baumy_list_items"."category_source" IN ('picked', 'remembered', 'similar', 'guessed'));