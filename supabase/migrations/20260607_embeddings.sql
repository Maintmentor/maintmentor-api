-- ============================================================
-- MaintMentor Day 6 Migration: Data Flywheel (Embeddings + RAG)
-- Created: 2026-06-07
-- Author: Mack (CTO)
-- ============================================================

-- ─── Enable pgvector extension ─────────────────────────────────────────────────
-- Required for VECTOR column type and similarity search.
-- Must be enabled by a superuser or database owner.
-- In Supabase: Dashboard → Database → Extensions → search "vector" → enable
-- Or via SQL (requires superuser):
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── knowledge_embeddings ──────────────────────────────────────────────────────
-- Stores embedded Q&A pairs for RAG retrieval.
-- embedding: 768-dimensional float vector (Gemini text-embedding-004 output size)
-- metadata: JSONB with source, confidence, wallet_id (anonymized), category
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content     TEXT NOT NULL,
  embedding   VECTOR(768) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast approximate nearest-neighbor search using cosine distance.
-- hnsw is preferred over ivfflat for real-time inserts (no training step required).
CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_idx
  ON knowledge_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- ─── embedding_queue ───────────────────────────────────────────────────────────
-- Temporary queue for Q&A pairs pending embedding.
-- Worker pulls pending rows, embeds them, moves to knowledge_embeddings, marks done.
CREATE TABLE IF NOT EXISTS embedding_queue (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'done', 'error')),
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Index for fast worker queries (only pulls pending rows)
CREATE INDEX IF NOT EXISTS embedding_queue_status_idx
  ON embedding_queue (status, created_at);

-- ─── match_embeddings RPC ──────────────────────────────────────────────────────
-- Cosine similarity search function callable from the Supabase JS client via .rpc()
-- Returns rows where 1 - cosine_distance >= match_threshold, ordered by similarity desc.
--
-- Usage (from JS):
--   supabase.rpc('match_embeddings', {
--     query_embedding: [...],
--     match_threshold: 0.75,
--     match_count: 3
--   })
CREATE OR REPLACE FUNCTION match_embeddings(
  query_embedding VECTOR(768),
  match_threshold FLOAT DEFAULT 0.75,
  match_count     INT   DEFAULT 3
)
RETURNS TABLE (
  id         UUID,
  content    TEXT,
  metadata   JSONB,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    content,
    metadata,
    1 - (embedding <=> query_embedding) AS similarity
  FROM knowledge_embeddings
  WHERE 1 - (embedding <=> query_embedding) >= match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
