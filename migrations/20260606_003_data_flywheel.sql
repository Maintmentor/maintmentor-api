-- ============================================================================
-- Migration: 20260606_003_data_flywheel
-- Author:    Mack (CTO, MaintMentor.ai)
-- Date:      2026-06-06
-- Purpose:   Data flywheel — every query becomes a training asset.
--            Creates query_history, query_embeddings (pgvector), and
--            data_quality_flags tables. Includes the search_similar_queries
--            RPC for RAG retrieval at inference time.
--
-- Dependencies:
--   - 20260606_001_agent_api_core (no direct FK, but logical dependency)
--   - pgvector extension (must be enabled — see README.md)
--
-- Idempotent:   Yes — CREATE TABLE/INDEX use IF NOT EXISTS; extension CREATE is safe.
-- Rollback:     20260606_003_data_flywheel.rollback.sql
--
-- Spec ref:  agent-api-wallet-spec.md Section 12
-- ============================================================================

-- ============================================================================
-- EXTENSION: vector (pgvector)
-- Required for VECTOR(1536) column type and ivfflat index.
-- Safe to run multiple times — IF NOT EXISTS is a no-op if already enabled.
-- Must be enabled in Supabase Dashboard → Extensions before running this migration.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================================================
-- TABLE: query_history
-- Canonical log of every question asked through MaintMentor, across all sources.
-- Never stores: raw photos, PII (anonymized before insert), raw API keys.
-- Embedding pipeline columns (embedding_status, embedding_attempts) are included
-- here rather than via ALTER so the table is complete from first run.
-- ============================================================================
CREATE TABLE IF NOT EXISTS query_history (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),

  -- Core content (PII-stripped before insert — see anonymizeQuery() in spec Section 12.5)
  question            TEXT        NOT NULL,              -- Cleaned/anonymized query text
  context             JSONB,                             -- Appliance type, model, age, etc. (max 8KB)
  ai_answer           TEXT,                              -- Full response text (null if AI call failed)
  model_used          TEXT        NOT NULL,              -- e.g. "gpt-4o", "claude-sonnet-4"

  -- Token & performance tracking
  tokens_input        INTEGER     NOT NULL DEFAULT 0,
  tokens_output       INTEGER     NOT NULL DEFAULT 0,
  latency_ms          INTEGER     NOT NULL DEFAULT 0,    -- Wall clock: request received → response sent

  -- Source attribution
  source              TEXT        NOT NULL,              -- 'consumer_app' or 'agent_api'
  account_id          UUID,                              -- Supabase user ID or API key owner (null = anonymous)
  session_id          TEXT,                              -- App session or API request group

  -- Photo metadata (image itself is NEVER stored — hash only for dedup)
  has_photo           BOOLEAN     NOT NULL DEFAULT FALSE,
  photo_hash          TEXT,                              -- SHA-256 of photo bytes; dedup only

  -- Feedback signals (populated via PATCH /api/app/query/{id}/feedback)
  feedback            TEXT,                              -- 'helpful', 'not_helpful', or null (no feedback yet)
  feedback_note       TEXT,                              -- Optional user comment ("answer was too vague")

  -- Quality control
  flagged             BOOLEAN     NOT NULL DEFAULT FALSE,  -- Flagged for human review
  flag_reason         TEXT,                                -- "low_confidence", "user_report", "auto_filter"

  -- Embedding pipeline state (consumed by pg_cron embedding worker)
  embedding_status    TEXT        NOT NULL DEFAULT 'pending', -- pending → processing → done | failed
  embedding_attempts  INTEGER     NOT NULL DEFAULT 0,         -- Attempt counter; max 3

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_query_history PRIMARY KEY (id),
  CONSTRAINT chk_query_history_source
    CHECK (source IN ('consumer_app', 'agent_api')),
  CONSTRAINT chk_query_history_feedback
    CHECK (feedback IS NULL OR feedback IN ('helpful', 'not_helpful')),
  CONSTRAINT chk_query_history_embedding_status
    CHECK (embedding_status IN ('pending', 'processing', 'done', 'failed')),
  CONSTRAINT chk_query_history_embedding_attempts_non_negative
    CHECK (embedding_attempts >= 0),
  CONSTRAINT chk_query_history_embedding_attempts_max
    CHECK (embedding_attempts <= 3),
  CONSTRAINT chk_query_history_tokens_non_negative
    CHECK (tokens_input >= 0 AND tokens_output >= 0),
  CONSTRAINT chk_query_history_latency_non_negative
    CHECK (latency_ms >= 0),
  CONSTRAINT chk_query_history_context_size
    CHECK (octet_length(context::text) <= 8192)  -- 8KB max on context JSONB (spec Section 13.1)
);

-- Index justification: usage dashboard + per-account history endpoint paginates by account + recency.
CREATE INDEX IF NOT EXISTS idx_query_history_account_created
  ON query_history (account_id, created_at DESC)
  WHERE account_id IS NOT NULL;

-- Index justification: analytics queries filter by source (consumer_app vs agent_api) + date range.
CREATE INDEX IF NOT EXISTS idx_query_history_source_created
  ON query_history (source, created_at DESC);

-- Index justification: feedback analysis queries (training data extraction, quality reviews).
-- Partial: only rows with feedback set — most rows start with no feedback.
CREATE INDEX IF NOT EXISTS idx_query_history_feedback
  ON query_history (feedback)
  WHERE feedback IS NOT NULL;

-- Index justification: human review queue and ops dashboard filter for flagged queries.
-- Partial: only flagged rows — should remain a small subset.
CREATE INDEX IF NOT EXISTS idx_query_history_flagged
  ON query_history (created_at DESC)
  WHERE flagged = TRUE;

-- Index justification: data retention purge (pg_cron monthly DELETE WHERE created_at < cutoff).
-- Also used by fine-tuning data export queries sorted by date.
CREATE INDEX IF NOT EXISTS idx_query_history_created_at
  ON query_history (created_at DESC);

-- Index justification: embedding worker polls for pending rows ordered by recency.
-- Partial: only non-done rows — once embedded, queries drop out of this index.
CREATE INDEX IF NOT EXISTS idx_query_history_embedding_pending
  ON query_history (created_at ASC)
  WHERE embedding_status IN ('pending', 'processing') AND embedding_attempts < 3;


-- ============================================================================
-- TABLE: query_embeddings
-- Vector representations of each query for semantic similarity search (RAG).
-- One row per query_history row. Generated asynchronously by embedding worker.
-- VECTOR(1536): OpenAI text-embedding-3-small outputs 1536 dimensions (~6KB/row).
-- At 100K rows ≈ 600MB. At 1M rows ≈ 6GB. Plan storage accordingly.
-- ============================================================================
CREATE TABLE IF NOT EXISTS query_embeddings (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  query_history_id    UUID        NOT NULL,
  embedding           VECTOR(1536) NOT NULL,              -- OpenAI text-embedding-3-small vector
  embedding_model     TEXT        NOT NULL DEFAULT 'text-embedding-3-small',
  embedded_text       TEXT        NOT NULL,               -- Exact text that was embedded (question + key context)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_query_embeddings PRIMARY KEY (id),
  CONSTRAINT fk_query_embeddings_query_history_id
    FOREIGN KEY (query_history_id) REFERENCES query_history(id) ON DELETE CASCADE,
  CONSTRAINT uq_query_embeddings_query_history_id
    UNIQUE (query_history_id),  -- One embedding per query; enforces 1:1 with query_history
  CONSTRAINT chk_query_embeddings_model_known
    CHECK (embedding_model IN ('text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'))
);

-- Index justification: ivfflat approximate nearest-neighbor search.
-- This is the pgvector similarity search index — required for cosine distance queries.
-- lists=100 is appropriate for datasets up to ~1M rows. Increase to 1000 at >1M rows.
-- NOTE: Build this index AFTER initial data load for best performance.
--       On an empty table it's fast; on millions of rows, build with CONCURRENTLY.
CREATE INDEX IF NOT EXISTS idx_query_embeddings_ivfflat
  ON query_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index justification: embedding worker checks for existing embeddings by query_history_id
-- before inserting. The UNIQUE constraint creates an implicit B-tree index, but explicit
-- naming makes it visible in migrations and monitoring.
-- (UNIQUE constraint above handles this — no separate CREATE INDEX needed)


-- ============================================================================
-- TABLE: data_quality_flags
-- Human review queue. Queries flagged by users, auto-filters, or weekly review
-- land here for assessment. Corrected answers become gold-label training data.
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_quality_flags (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  query_history_id    UUID        NOT NULL,

  -- Flag metadata
  flag_source         TEXT        NOT NULL,   -- Who/what triggered this flag
  flag_reason         TEXT,                   -- Specific reason (e.g. "hallucination_suspected")
  severity            TEXT,                   -- Triage priority

  -- Review workflow
  reviewer_notes      TEXT,                   -- Reviewer's assessment
  corrected_answer    TEXT,                   -- Improved answer (gold label for fine-tuning)
  review_verdict      TEXT,                   -- Final determination
  reviewed_by         TEXT,                   -- Reviewer name or user ID
  reviewed_at         TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_data_quality_flags PRIMARY KEY (id),
  CONSTRAINT fk_data_quality_flags_query_history_id
    FOREIGN KEY (query_history_id) REFERENCES query_history(id) ON DELETE CASCADE,
  CONSTRAINT uq_data_quality_flags_query_history_id
    UNIQUE (query_history_id),  -- One flag record per query (avoids duplicate review entries)
  CONSTRAINT chk_data_quality_flags_flag_source
    CHECK (flag_source IN ('user_feedback', 'auto_filter', 'weekly_review', 'load_test')),
  CONSTRAINT chk_data_quality_flags_severity
    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT chk_data_quality_flags_review_verdict
    CHECK (review_verdict IS NULL OR
           review_verdict IN ('confirmed_good', 'confirmed_bad', 'corrected', 'inconclusive')),
  CONSTRAINT chk_data_quality_flags_review_consistency
    CHECK (
      (reviewed_at IS NULL AND review_verdict IS NULL AND reviewed_by IS NULL)
      OR
      (reviewed_at IS NOT NULL AND review_verdict IS NOT NULL AND reviewed_by IS NOT NULL)
    )
);

-- Index justification: review queue UI shows unreviewed flags, ordered by creation date.
-- Partial: only unreviewed rows — reviewed rows drop out of this index, keeping it small.
CREATE INDEX IF NOT EXISTS idx_data_quality_flags_unreviewed
  ON data_quality_flags (created_at ASC)
  WHERE reviewed_at IS NULL;

-- Index justification: ops triage prioritizes by severity; critical flags need immediate attention.
CREATE INDEX IF NOT EXISTS idx_data_quality_flags_severity_created
  ON data_quality_flags (severity, created_at DESC);

-- Index justification: fine-tuning data export selects corrected answers (gold labels).
-- Partial: only rows with corrected answers.
CREATE INDEX IF NOT EXISTS idx_data_quality_flags_corrected
  ON data_quality_flags (created_at DESC)
  WHERE corrected_answer IS NOT NULL;


-- ============================================================================
-- RPC: search_similar_queries
-- Semantic similarity search using pgvector cosine distance.
-- Called at inference time to retrieve top-N similar past queries for RAG injection.
--
-- Performance: ~200ms at 100K rows with ivfflat index. Monitor and cache if needed.
-- Filters:
--   - flagged = FALSE (never surface flagged queries as examples)
--   - feedback != 'not_helpful' (never surface negatively-rated answers)
--   - similarity > match_threshold (default 0.78 — tune based on quality)
-- ============================================================================
CREATE OR REPLACE FUNCTION search_similar_queries(
  query_embedding  VECTOR(1536),
  match_threshold  FLOAT   DEFAULT 0.78,
  match_count      INT     DEFAULT 5
)
RETURNS TABLE (
  query_history_id  UUID,
  question          TEXT,
  ai_answer         TEXT,
  similarity        FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    qe.query_history_id,
    qh.question,
    qh.ai_answer,
    1 - (qe.embedding <=> query_embedding) AS similarity
  FROM query_embeddings qe
  JOIN query_history qh ON qh.id = qe.query_history_id
  WHERE
    qh.flagged = FALSE                                        -- Never use flagged queries as RAG examples
    AND (qh.feedback IS NULL OR qh.feedback != 'not_helpful') -- Never surface negatively-rated answers
    AND qh.ai_answer IS NOT NULL                              -- Only use queries that have an answer
    AND 1 - (qe.embedding <=> query_embedding) > match_threshold
  ORDER BY qe.embedding <=> query_embedding                   -- Cosine distance ascending (closer = more similar)
  LIMIT match_count;
END;
$$;


-- ============================================================================
-- RPC: get_feedback_stats
-- Summarizes feedback signal quality for monitoring and fine-tuning readiness.
-- Called by the daily report cron and the ops dashboard.
-- ============================================================================
CREATE OR REPLACE FUNCTION get_feedback_stats(
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total          INTEGER;
  v_helpful        INTEGER;
  v_not_helpful    INTEGER;
  v_flagged        INTEGER;
  v_embedded_done  INTEGER;
  v_embedded_fail  INTEGER;
BEGIN
  SELECT
    COUNT(*)                                              INTO v_total
  FROM query_history
  WHERE created_at >= p_since;

  SELECT COUNT(*) INTO v_helpful
  FROM query_history
  WHERE created_at >= p_since AND feedback = 'helpful';

  SELECT COUNT(*) INTO v_not_helpful
  FROM query_history
  WHERE created_at >= p_since AND feedback = 'not_helpful';

  SELECT COUNT(*) INTO v_flagged
  FROM query_history
  WHERE created_at >= p_since AND flagged = TRUE;

  SELECT COUNT(*) INTO v_embedded_done
  FROM query_history
  WHERE created_at >= p_since AND embedding_status = 'done';

  SELECT COUNT(*) INTO v_embedded_fail
  FROM query_history
  WHERE created_at >= p_since AND embedding_status = 'failed';

  RETURN jsonb_build_object(
    'period_start',       p_since,
    'total_queries',      v_total,
    'helpful',            v_helpful,
    'not_helpful',        v_not_helpful,
    'no_feedback',        v_total - v_helpful - v_not_helpful,
    'feedback_rate_pct',  CASE WHEN v_total > 0
                            THEN ROUND(((v_helpful + v_not_helpful)::NUMERIC / v_total) * 100, 1)
                            ELSE 0 END,
    'flagged',            v_flagged,
    'embedding_done',     v_embedded_done,
    'embedding_failed',   v_embedded_fail
  );
END;
$$;


-- ============================================================================
-- PURGE FUNCTION: purge_old_query_history
-- Deletes query_history rows older than 24 months (spec Section 12.5).
-- Cascade deletes associated query_embeddings and data_quality_flags.
-- Intended to be scheduled via pg_cron (monthly, low-traffic window).
--
-- Example pg_cron setup (run from Supabase SQL editor):
--   SELECT cron.schedule('purge-query-history', '0 3 1 * *',
--     $$SELECT purge_old_query_history()$$);
-- ============================================================================
CREATE OR REPLACE FUNCTION purge_old_query_history()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted INTEGER;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 months';
BEGIN
  DELETE FROM query_history
  WHERE created_at < v_cutoff;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_rows', v_deleted,
    'cutoff_date',  v_cutoff,
    'purged_at',    NOW()
  );
END;
$$;


-- ============================================================================
-- VERIFICATION QUERIES
--
-- SELECT extname FROM pg_extension WHERE extname = 'vector';
-- Expected: 1 row ('vector')
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('query_history','query_embeddings','data_quality_flags')
--   ORDER BY table_name;
-- Expected: 3 rows
--
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'query_history'
--   AND column_name IN ('embedding_status','embedding_attempts')
--   ORDER BY column_name;
-- Expected: 2 rows (confirms embedding pipeline columns included)
--
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--   AND routine_name IN ('search_similar_queries','get_feedback_stats','purge_old_query_history')
--   ORDER BY routine_name;
-- Expected: 3 rows
-- ============================================================================
