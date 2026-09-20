-- Phase 11 item 3: per-chunk embedding for the optional hybrid retrieval mode (RETRIEVAL_MODE=hybrid).
-- Stored as a plain double precision array (no pgvector); cosine similarity is computed in the API.
ALTER TABLE "knowledge_chunk"
  ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
  ADD COLUMN "embedding_model" TEXT;
