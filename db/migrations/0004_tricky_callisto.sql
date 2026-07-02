-- Switch embeddings from 1536-dim (OpenAI) to 384-dim (local in-process embedder).
-- The HNSW indexes are dimension-bound and depend on these columns, so they must
-- be dropped before the ALTER TYPE and recreated after. Columns are empty on a
-- fresh deploy, so the type change is instant.
DROP INDEX IF EXISTS "baumy_memory_embeddings_hnsw_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "baumy_entities_name_hnsw_idx";--> statement-breakpoint
ALTER TABLE "baumy_entities" ALTER COLUMN "name_embedding" SET DATA TYPE vector(384);--> statement-breakpoint
ALTER TABLE "baumy_memory_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(384);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_memory_embeddings_hnsw_idx" ON "baumy_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baumy_entities_name_hnsw_idx" ON "baumy_entities" USING hnsw ("name_embedding" vector_cosine_ops);
