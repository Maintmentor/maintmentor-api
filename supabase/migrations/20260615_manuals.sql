-- =============================================================
-- Manual Documents + Chunks (PDF Knowledge Base)
-- Run in Supabase SQL Editor: Dashboard → SQL Editor → New query
-- =============================================================

-- 1. Raw manual metadata (one row per PDF)
CREATE TABLE IF NOT EXISTS manual_documents (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text        NOT NULL,
  filename        text        NOT NULL,
  storage_path    text        NOT NULL,          -- path inside 'manuals' bucket
  file_size_bytes integer,
  category        text        DEFAULT 'general', -- e.g. hvac, plumbing, electrical
  manufacturer    text,
  model_number    text,
  system_type     text,                          -- e.g. "split AC", "water heater"
  uploaded_by     text        DEFAULT 'admin',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 2. Chunked text for full-text search (one row per ~500-word chunk)
CREATE TABLE IF NOT EXISTS manual_chunks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_id    uuid        NOT NULL REFERENCES manual_documents(id) ON DELETE CASCADE,
  chunk_index  integer     NOT NULL,
  content      text        NOT NULL,
  page_hint    integer,                          -- approximate PDF page
  created_at   timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_manual_chunks_manual_id
  ON manual_chunks(manual_id);

CREATE INDEX IF NOT EXISTS idx_manual_chunks_fts
  ON manual_chunks USING gin(to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_manual_docs_category
  ON manual_documents(category);

CREATE INDEX IF NOT EXISTS idx_manual_docs_system_type
  ON manual_documents(system_type);

-- 3. Full-text search RPC (called by lib/manuals.js)
CREATE OR REPLACE FUNCTION search_manual_chunks(
  search_query  text,
  result_limit  int  DEFAULT 4,
  min_rank      float DEFAULT 0.01
)
RETURNS TABLE (
  chunk_id     uuid,
  manual_id    uuid,
  title        text,
  category     text,
  manufacturer text,
  model_number text,
  system_type  text,
  content      text,
  rank         float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id            AS chunk_id,
    c.manual_id,
    d.title,
    d.category,
    d.manufacturer,
    d.model_number,
    d.system_type,
    c.content,
    ts_rank_cd(
      to_tsvector('english', c.content),
      to_tsquery('english', search_query)
    )::float        AS rank
  FROM  manual_chunks    c
  JOIN  manual_documents d ON d.id = c.manual_id
  WHERE to_tsvector('english', c.content)
        @@ to_tsquery('english', search_query)
    AND ts_rank_cd(
          to_tsvector('english', c.content),
          to_tsquery('english', search_query)
        ) >= min_rank
  ORDER BY rank DESC
  LIMIT result_limit;
$$;
