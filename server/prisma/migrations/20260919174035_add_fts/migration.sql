-- Full-text search setup for knowledge_chunk (Phase 1).
-- The init migration created search_vector as a plain tsvector column (Prisma's Unsupported type),
-- so it is dropped and re-added as a STORED generated column that Postgres maintains automatically.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "knowledge_chunk" DROP COLUMN IF EXISTS "search_vector";

ALTER TABLE "knowledge_chunk" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("heading", '') || ' ' || "content")) STORED;

CREATE INDEX IF NOT EXISTS "knowledge_chunk_search_vector_idx" ON "knowledge_chunk" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS "knowledge_chunk_content_trgm_idx" ON "knowledge_chunk" USING GIN ("content" gin_trgm_ops);
