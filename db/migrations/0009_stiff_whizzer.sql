ALTER TABLE "baumy_facts" ADD COLUMN "source_memory_item_id" uuid;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD COLUMN "derived_from_fact_id" uuid;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_source_memory_item_id_baumy_memory_items_id_fk" FOREIGN KEY ("source_memory_item_id") REFERENCES "public"."baumy_memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baumy_facts" ADD CONSTRAINT "baumy_facts_derived_from_fact_id_baumy_facts_id_fk" FOREIGN KEY ("derived_from_fact_id") REFERENCES "public"."baumy_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baumy_facts_subject_idx" ON "baumy_facts" USING btree ("subject_entity_id");--> statement-breakpoint
CREATE INDEX "baumy_facts_derived_idx" ON "baumy_facts" USING btree ("derived_from_fact_id");