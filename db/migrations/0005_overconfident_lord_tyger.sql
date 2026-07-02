-- Switch embeddings to 512-dim (Voyage 3.5-lite, semantic) from the 384-dim
-- lexical-hash embedder. Existing embedding rows are old hash vectors — worthless
-- after the swap AND they would block ALTER TYPE (dimension mismatch) — so clear
-- them; the reembed-sweep cron backfills memory_items with Voyage vectors. HNSW
-- indexes are dimension-bound, so drop before the ALTER and recreate after.
DELETE FROM "baumy_memory_embeddings";--> statement-breakpoint
UPDATE "baumy_entities" SET "name_embedding" = NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "baumy_memory_embeddings_hnsw_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "baumy_entities_name_hnsw_idx";--> statement-breakpoint
ALTER TABLE "baumy_entities" ALTER COLUMN "name_embedding" SET DATA TYPE vector(512);--> statement-breakpoint
ALTER TABLE "baumy_memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(512);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_memory_embeddings_hnsw_idx" ON "baumy_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_entities_name_hnsw_idx" ON "baumy_entities" USING hnsw ("name_embedding" vector_cosine_ops);
