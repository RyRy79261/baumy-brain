CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "baumy_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "baumy_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"action" text NOT NULL,
	"actor_member_id" text,
	"target" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[],
	"name_embedding" vector(1536),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"subject_entity_id" uuid,
	"predicate" text NOT NULL,
	"object_entity_id" uuid,
	"object_value" text,
	"object_json" jsonb,
	"authored_by" text,
	"trust_level" text DEFAULT 'untrusted' NOT NULL,
	"is_secure" boolean DEFAULT false NOT NULL,
	"value_ciphertext" text,
	"value_iv" text,
	"key_version" smallint,
	"event_at" timestamp with time zone,
	"recurrence" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "baumy_house_config" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"house_group_chat_id" text,
	"house_timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"response_policy" jsonb DEFAULT '{"global_enabled":true,"categories":{"scheduling":true,"info_lookup":true},"confidence_threshold":0.7,"muted_topics":[]}'::jsonb NOT NULL,
	"daily_spend_cap_usd" numeric DEFAULT '0.50' NOT NULL,
	"secure_key_version" smallint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baumy_house_config_singleton" CHECK ("baumy_house_config"."id")
);
--> statement-breakpoint
CREATE TABLE "baumy_llm_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "baumy_llm_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"role" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"update_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_members" (
	"telegram_user_id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"can_access_dashboard" boolean DEFAULT false NOT NULL,
	"dm_chat_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_message_id" uuid,
	"memory_type" text NOT NULL,
	"content" text NOT NULL,
	"authored_by" text,
	"trust_level" text DEFAULT 'untrusted' NOT NULL,
	"salience" real DEFAULT 0.5 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"author_member_id" text,
	"text" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"model" text,
	"params" jsonb,
	"label" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"deliver_chat_id" text NOT NULL,
	"content" text NOT NULL,
	"anchor_kind" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"event_fact_id" uuid,
	"lead_interval" interval,
	"recurrence" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_replies" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"prompt" text NOT NULL,
	"cadence" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"until_expiry" timestamp with time zone,
	"until_condition" text,
	"requester_member_id" text,
	"model_tier" text DEFAULT 'assess' NOT NULL,
	"web_search_enabled" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_telegram_chats" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'house_group' NOT NULL,
	"title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baumy_telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "baumy_entities" ADD CONSTRAINT "baumy_entities_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_subject_entity_id_baumy_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."baumy_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_object_entity_id_baumy_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."baumy_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_authored_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_superseded_by_baumy_facts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."baumy_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_members" ADD CONSTRAINT "baumy_members_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_memory_embeddings" ADD CONSTRAINT "baumy_memory_embeddings_memory_item_id_baumy_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."baumy_memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_memory_items" ADD CONSTRAINT "baumy_memory_items_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_memory_items" ADD CONSTRAINT "baumy_memory_items_source_message_id_baumy_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."baumy_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_memory_items" ADD CONSTRAINT "baumy_memory_items_authored_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("authored_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD CONSTRAINT "baumy_messages_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_messages" ADD CONSTRAINT "baumy_messages_author_member_id_baumy_members_telegram_user_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_reminders" ADD CONSTRAINT "baumy_reminders_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_reminders" ADD CONSTRAINT "baumy_reminders_event_fact_id_baumy_facts_id_fk" FOREIGN KEY ("event_fact_id") REFERENCES "public"."baumy_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_reminders" ADD CONSTRAINT "baumy_reminders_created_by_baumy_members_telegram_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_scheduled_tasks" ADD CONSTRAINT "baumy_scheduled_tasks_group_id_baumy_telegram_chats_chat_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."baumy_telegram_chats"("chat_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_scheduled_tasks" ADD CONSTRAINT "baumy_scheduled_tasks_requester_member_id_baumy_members_telegram_user_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."baumy_members"("telegram_user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baumy_facts_group_current_idx" ON "baumy_facts" USING btree ("group_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_memory_embeddings_item_model_uq" ON "baumy_memory_embeddings" USING btree ("memory_item_id","model");--> statement-breakpoint
CREATE INDEX "baumy_messages_group_idx" ON "baumy_messages" USING btree ("group_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "baumy_prompts_name_version_uq" ON "baumy_prompts" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "baumy_reminders_due_idx" ON "baumy_reminders" USING btree ("status","fire_at");--> statement-breakpoint
CREATE INDEX "baumy_scheduled_tasks_active_idx" ON "baumy_scheduled_tasks" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_memory_embeddings_hnsw_idx" ON "baumy_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_entities_name_hnsw_idx" ON "baumy_entities" USING hnsw ("name_embedding" vector_cosine_ops);--> statement-breakpoint
INSERT INTO "baumy_house_config" ("id") VALUES (true) ON CONFLICT DO NOTHING;
